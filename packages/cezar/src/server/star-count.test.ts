import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CEZAR_REPO_URL,
  STAR_CACHE_TTL_MS,
  STAR_FAILURE_BACKOFF_MS,
  STAR_MAX_PACE_MS,
  StarCountReader,
  fetchStarCount,
  rateLimitWaitMs,
  readStarCount,
  starAskSilenced,
  starCachePath,
} from './star-count.ts';

/** A `fetch` stand-in that counts its calls, so "one request per burst" is testable. */
function stubFetch(responses: Array<() => Promise<Response> | Response>): typeof fetch & { calls: number } {
  let index = 0;
  const impl = (async () => {
    const make = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    impl.calls = index;
    return make();
  }) as unknown as typeof fetch & { calls: number };
  impl.calls = 0;
  return impl;
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => () => new Response('', { status: code });
const boom = () => () => Promise.reject(new Error('offline'));
const withHeaders = (code: number, headers: Record<string, string>, body: unknown = {}) => () =>
  new Response(JSON.stringify(body), { status: code, headers });

describe('star count — the wire read', () => {
  it('returns the stargazer count from a well-formed payload', async () => {
    await expect(fetchStarCount(stubFetch([ok({ stargazers_count: 1234 })]))).resolves.toBe(1234);
  });

  it('degrades to null on a non-2xx, including the rate-limit 403', async () => {
    await expect(fetchStarCount(stubFetch([status(403)]))).resolves.toBeNull();
    await expect(fetchStarCount(stubFetch([status(404)]))).resolves.toBeNull();
  });

  it('degrades to null on a network failure rather than throwing', async () => {
    await expect(fetchStarCount(stubFetch([boom()]))).resolves.toBeNull();
  });

  it('degrades to null when the payload does not carry a usable count', async () => {
    await expect(fetchStarCount(stubFetch([ok({ stargazers_count: 'lots' })]))).resolves.toBeNull();
    await expect(fetchStarCount(stubFetch([ok({ stargazers_count: -1 })]))).resolves.toBeNull();
    await expect(fetchStarCount(stubFetch([ok({})]))).resolves.toBeNull();
    await expect(fetchStarCount(stubFetch([() => new Response('not json', { status: 200 })]))).resolves.toBeNull();
  });
});

describe('star count — the off switch', () => {
  it('is silenced only by the literal CEZ_NO_BANNER=1', () => {
    expect(starAskSilenced({ CEZ_NO_BANNER: '1' })).toBe(true);
    expect(starAskSilenced({ CEZ_NO_BANNER: 'true' })).toBe(false);
    expect(starAskSilenced({ CEZ_NO_BANNER: '0' })).toBe(false);
    expect(starAskSilenced({})).toBe(false);
  });

  it('is also silenced under vitest, so the unit gate can never become networked', () => {
    // `createApp` hands a DEFAULT reader to every test that builds an app. Today no case
    // requests `/api/v1/star-count`, so nothing reaches github.com — but that is an accident of
    // which routes the suite happens to hit, and the first test to change that would silently
    // make `npm test` networked and non-deterministic. Same guard shape as
    // `assertCezarHomeWriteIsSandboxed`.
    expect(starAskSilenced({ VITEST: 'true' })).toBe(true);
    // And this very process is one, so the ambient default is closed:
    expect(starAskSilenced()).toBe(true);
  });

  it('still lets a test drive the fetch path deliberately, with its own fetch', async () => {
    // The guard closes the SHARED reader's default, not the wire read itself — otherwise the
    // cases above could not cover the thing they exist to cover.
    await expect(fetchStarCount(stubFetch([ok({ stargazers_count: 5 })]))).resolves.toBe(5);
  });
});

describe('star count — the reader', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-stars-'));
    cachePath = join(dir, 'star-count.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reader = (fetchImpl: typeof fetch, now = () => 1_000_000, env: NodeJS.ProcessEnv = {}) =>
    new StarCountReader({ fetchImpl, cachePath, env, now });

  it('answers with the count and the repo URL', async () => {
    await expect(reader(stubFetch([ok({ stargazers_count: 842 })])).read()).resolves.toEqual({
      available: true,
      count: 842,
      url: CEZAR_REPO_URL,
    });
  });

  it('never spends a request while silenced, and answers unavailable', async () => {
    const fetchImpl = stubFetch([ok({ stargazers_count: 842 })]);
    const result = await reader(fetchImpl, () => 1_000_000, { CEZ_NO_BANNER: '1' }).read();
    expect(result).toEqual({ available: false, url: CEZAR_REPO_URL });
    expect(fetchImpl.calls).toBe(0);
  });

  it('serves the memory cache inside the TTL and refetches past it', async () => {
    let clock = 1_000_000;
    const fetchImpl = stubFetch([ok({ stargazers_count: 10 }), ok({ stargazers_count: 11 })]);
    const r = new StarCountReader({ fetchImpl, cachePath, env: {}, now: () => clock });

    await expect(r.read()).resolves.toMatchObject({ count: 10 });
    clock += STAR_CACHE_TTL_MS - 1;
    await expect(r.read()).resolves.toMatchObject({ count: 10 });
    expect(fetchImpl.calls).toBe(1);

    clock += 2;
    await expect(r.read()).resolves.toMatchObject({ count: 11 });
    expect(fetchImpl.calls).toBe(2);
  });

  it('collapses a burst of concurrent reads into one request', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = stubFetch([async () => {
      await gate;
      return new Response(JSON.stringify({ stargazers_count: 77 }), { status: 200 });
    }]);
    const r = reader(fetchImpl);
    const all = Promise.all([r.read(), r.read(), r.read()]);
    release!();
    for (const result of await all) expect(result).toMatchObject({ count: 77 });
    expect(fetchImpl.calls).toBe(1);
  });

  it('writes the answer to disk and serves it on the next process without a request', async () => {
    await reader(stubFetch([ok({ stargazers_count: 555 })])).read();
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({ count: 555 });

    const second = stubFetch([ok({ stargazers_count: 999 })]);
    await expect(reader(second).read()).resolves.toMatchObject({ count: 555 });
    expect(second.calls).toBe(0);
  });

  it('ignores a corrupt or malformed cache file instead of failing the read', async () => {
    writeFileSync(cachePath, '{ not json', 'utf8');
    await expect(reader(stubFetch([ok({ stargazers_count: 12 })])).read()).resolves.toMatchObject({ count: 12 });

    writeFileSync(cachePath, JSON.stringify({ count: 'many' }), 'utf8');
    await expect(reader(stubFetch([ok({ stargazers_count: 13 })])).read()).resolves.toMatchObject({ count: 13 });
  });

  it('keeps serving a stale disk count when the refresh fails', async () => {
    writeFileSync(cachePath, JSON.stringify({ count: 400, fetchedAtMs: 0 }), 'utf8');
    const fetchImpl = stubFetch([boom()]);
    const result = await reader(fetchImpl, () => STAR_CACHE_TTL_MS * 10).read();
    expect(fetchImpl.calls).toBe(1);
    expect(result).toMatchObject({ available: true, count: 400 });
  });

  it('answers unavailable — never a throw — when nothing is known and the fetch fails', async () => {
    await expect(reader(stubFetch([boom()])).read()).resolves.toEqual({
      available: false,
      url: CEZAR_REPO_URL,
    });
  });

  it('remembers a FAILURE too, so an offline machine does not re-spend the timeout every read', async () => {
    let clock = 1_000_000;
    const fetchImpl = stubFetch([boom(), ok({ stargazers_count: 7 })]);
    const r = new StarCountReader({ fetchImpl, cachePath, env: {}, now: () => clock });

    await expect(r.read()).resolves.toEqual({ available: false, url: CEZAR_REPO_URL });
    expect(fetchImpl.calls).toBe(1);

    // Every read inside the backoff window is answered from the remembered failure — no second
    // five-second timeout for a cockpit that reloads while the machine is still offline.
    clock += STAR_FAILURE_BACKOFF_MS - 1;
    await expect(r.read()).resolves.toEqual({ available: false, url: CEZAR_REPO_URL });
    expect(fetchImpl.calls).toBe(1);

    // And it is a backoff, not a give-up: past the window the next read tries again.
    clock += 2;
    await expect(r.read()).resolves.toMatchObject({ count: 7 });
    expect(fetchImpl.calls).toBe(2);
  });

  it('keeps serving a stale disk count through the backoff window rather than a blank chip', async () => {
    writeFileSync(cachePath, JSON.stringify({ count: 400, fetchedAtMs: 0 }), 'utf8');
    let clock = STAR_CACHE_TTL_MS * 10;
    const fetchImpl = stubFetch([boom()]);
    const r = new StarCountReader({ fetchImpl, cachePath, env: {}, now: () => clock });

    await expect(r.read()).resolves.toMatchObject({ available: true, count: 400 });
    clock += STAR_FAILURE_BACKOFF_MS - 1;
    await expect(r.read()).resolves.toMatchObject({ available: true, count: 400 });
    expect(fetchImpl.calls).toBe(1);
  });

  it('clears the backoff on a success, so one bad minute cannot mute the reader', async () => {
    let clock = 1_000_000;
    const fetchImpl = stubFetch([boom(), ok({ stargazers_count: 21 }), ok({ stargazers_count: 22 })]);
    const r = new StarCountReader({ fetchImpl, cachePath, env: {}, now: () => clock });

    await r.read();
    clock += STAR_FAILURE_BACKOFF_MS + 1;
    await expect(r.read()).resolves.toMatchObject({ count: 21 });

    // Past the TTL the reader refetches normally — the earlier failure left nothing behind.
    clock += STAR_CACHE_TTL_MS + 1;
    await expect(r.read()).resolves.toMatchObject({ count: 22 });
    expect(fetchImpl.calls).toBe(3);
  });

  it('caches under the global ~/.cache/cez directory, like every other cezar cache', () => {
    expect(starCachePath('/home/someone')).toBe('/home/someone/.cache/cez/star-count.json');
  });
});

describe('star count — rate-limit pacing', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-stars-pace-'));
    cachePath = join(dir, 'star-count.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refreshes on the ten-second cadence the cockpit polls at', () => {
    expect(STAR_CACHE_TTL_MS).toBe(10_000);
  });

  it('spreads the remaining hourly budget evenly to the reset', () => {
    const headers = new Headers({ 'x-ratelimit-remaining': '30', 'x-ratelimit-reset': '1800' });
    expect(rateLimitWaitMs(headers, 0)).toBe(60_000);
  });

  it('waits for the reset once the budget is spent, and prefers retry-after when sent', () => {
    expect(rateLimitWaitMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '600' }), 0)).toBe(600_000);
    expect(rateLimitWaitMs(new Headers({ 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '600' }), 0)).toBe(30_000);
  });

  it('ignores absent or garbled headers and bounds a far-future reset', () => {
    expect(rateLimitWaitMs(new Headers(), 0)).toBeUndefined();
    expect(rateLimitWaitMs(new Headers({ 'x-ratelimit-remaining': 'lots', 'x-ratelimit-reset': '600' }), 0)).toBeUndefined();
    expect(rateLimitWaitMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99999999' }), 0)).toBe(STAR_MAX_PACE_MS);
  });

  it('authenticates with GITHUB_TOKEN (or GH_TOKEN) when one is set, and only then', async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return new Response(JSON.stringify({ stargazers_count: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await readStarCount(fetchImpl, { GITHUB_TOKEN: 'tok-a' });
    await readStarCount(fetchImpl, { GH_TOKEN: 'tok-b' });
    await readStarCount(fetchImpl, {});
    expect(seen).toEqual(['Bearer tok-a', 'Bearer tok-b', null]);
  });

  it('slows an unauthenticated reader to its budget instead of spending it into a 403', async () => {
    let clock = 0;
    const fetchImpl = stubFetch([
      withHeaders(200, { 'x-ratelimit-remaining': '60', 'x-ratelimit-reset': '3600' }, { stargazers_count: 1 }),
      ok({ stargazers_count: 2 }),
    ]);
    const r = new StarCountReader({ fetchImpl, cachePath, env: {}, now: () => clock });

    await expect(r.read()).resolves.toMatchObject({ count: 1 });
    // Past the 10 s TTL but inside the paced minute: the held number, no request.
    clock += STAR_CACHE_TTL_MS + 1;
    await expect(r.read()).resolves.toMatchObject({ count: 1 });
    expect(fetchImpl.calls).toBe(1);

    clock = 60_000;
    await expect(r.read()).resolves.toMatchObject({ count: 2 });
    expect(fetchImpl.calls).toBe(2);
  });

  it('keeps the held count through a rate-limited 403 and retries only after the reset', async () => {
    let clock = 0;
    const fetchImpl = stubFetch([
      ok({ stargazers_count: 5 }),
      withHeaders(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '600' }),
      ok({ stargazers_count: 6 }),
    ]);
    const r = new StarCountReader({ fetchImpl, cachePath, env: {}, now: () => clock });

    await r.read();
    clock = STAR_CACHE_TTL_MS + 1;
    await expect(r.read()).resolves.toMatchObject({ available: true, count: 5 });
    expect(fetchImpl.calls).toBe(2);

    clock = 599_000;
    await expect(r.read()).resolves.toMatchObject({ count: 5 });
    expect(fetchImpl.calls).toBe(2);

    clock = 600_000 + STAR_CACHE_TTL_MS;
    await expect(r.read()).resolves.toMatchObject({ count: 6 });
    expect(fetchImpl.calls).toBe(3);
  });
});

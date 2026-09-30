import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CEZAR_REPO_URL,
  STAR_CACHE_TTL_MS,
  StarCountReader,
  fetchStarCount,
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

  it('caches under the global ~/.cache/cez directory, like every other cezar cache', () => {
    expect(starCachePath('/home/someone')).toBe('/home/someone/.cache/cez/star-count.json');
  });
});

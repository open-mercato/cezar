import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same seam as github.test.ts: `execFile` passes through to the real one unless a case overrides
// it, so the eviction regression below can drive `gh` without a real binary or the network.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  execFileMock.mockImplementation((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  createSwrCache,
  evictForgeProjectCaches,
  fetchBoundedPages,
  isNotFound,
  notFoundReason,
  runCli,
} from './cli.ts';
import {
  __clearCommentsCacheForTests,
  evictGithubProjectCaches,
  fetchGithubComments,
} from './github.ts';

describe('runCli / isNotFound / notFoundReason', () => {
  it('rejects with an ENOENT error that isNotFound recognizes when the binary is missing', async () => {
    const err = await runCli('cez-no-such-binary-847', process.cwd(), ['--version'], {
      timeoutMs: 5_000,
      maxBuffer: 1024,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isNotFound(err)).toBe(true);
  });

  it('does not call an ordinary failure "not found"', () => {
    expect(isNotFound(new Error('HTTP 502: Bad Gateway'))).toBe(false);
    expect(isNotFound('spawn gh ENOENT')).toBe(true);
  });

  it('keeps the GitHub install hint byte-identical', () => {
    expect(notFoundReason('gh')).toBe('gh CLI not found — install it and run `gh auth login`');
  });
});

describe('fetchBoundedPages', () => {
  const page = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i })));
  const base = { maxPages: 10, budgetMs: 15_000, minPageMs: 2_000, pageSize: 100 };

  it('ends on a short page without flagging stoppedShort', async () => {
    const run = vi.fn(async (p: number) => page(p === 2 ? 30 : 100));
    const { rows, stoppedShort } = await fetchBoundedPages(run, base);
    expect(run).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(130);
    expect(stoppedShort).toBe(false);
  });

  it('stops at the page cap and flags stoppedShort', async () => {
    const run = vi.fn(async () => page(20));
    const { rows, stoppedShort } = await fetchBoundedPages(run, { ...base, maxPages: 3, pageSize: 20 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(60);
    expect(stoppedShort).toBe(true);
  });

  it('shares one draining budget and stops before a page that cannot finish', async () => {
    let clock = 0;
    const handed: number[] = [];
    const run = vi.fn(async (_p: number, timeoutMs: number) => {
      handed.push(timeoutMs);
      clock += 6_000;
      return page(100);
    });
    const { stoppedShort } = await fetchBoundedPages(run, { ...base, now: () => clock });
    // 15 s → 9 s → 3 s; the fourth would get -3 s, under the 2 s floor.
    expect(handed).toEqual([15_000, 9_000, 3_000]);
    expect(stoppedShort).toBe(true);
  });

  it('rethrows a page-1 failure', async () => {
    const run = vi.fn(async () => {
      throw new Error('HTTP 404');
    });
    await expect(fetchBoundedPages(run, base)).rejects.toThrow('HTTP 404');
  });

  it('keeps earlier pages and stops short when a later page fails', async () => {
    const run = vi.fn(async (p: number) => {
      if (p === 3) throw new Error('HTTP 502');
      return page(100);
    });
    const { rows, stoppedShort } = await fetchBoundedPages(run, base);
    expect(rows).toHaveLength(200);
    expect(stoppedShort).toBe(true);
  });
});

describe('createSwrCache', () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    clock = 0;
  });

  /** A loader whose calls are counted and whose answer carries the call number. */
  const counting = () => {
    const calls: string[] = [];
    const load = vi.fn(async (key: string) => {
      calls.push(key);
      return `${key}#${calls.length}`;
    });
    return { calls, load };
  };

  it('is null when cold, then serves the warmed value without reloading', async () => {
    const { load } = counting();
    const cache = createSwrCache({ ttlMs: 1_000, max: 10, load, now });
    expect(cache.peek('a')).toBeNull();
    await cache.get('a'); // the background warm-up the cold peek started
    expect(cache.peek('a')).toBe('a#1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value while one background revalidation refreshes it', async () => {
    const { load } = counting();
    const cache = createSwrCache({ ttlMs: 1_000, max: 10, load, now });
    await cache.get('a');
    clock = 1_001;
    expect(cache.peek('a')).toBe('a#1'); // stale, never null
    expect(cache.peek('a')).toBe('a#1'); // joins the same revalidation
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get('a'); // joins the in-flight revalidation
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek('a')).toBe('a#2');
  });

  it('joins an in-flight load instead of calling the loader twice', async () => {
    const { load } = counting();
    const cache = createSwrCache({ ttlMs: 1_000, max: 10, load, now });
    expect(cache.peek('a')).toBeNull();
    const [x, y] = await Promise.all([cache.get('a'), cache.get('a')]);
    expect(x).toBe('a#1');
    expect(y).toBe('a#1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps two keys independent — probing one never evicts the other', async () => {
    const { load } = counting();
    const cache = createSwrCache({ ttlMs: 1_000, max: 10, load, now });
    await cache.get('a');
    await cache.get('b');
    expect(cache.peek('a')).toBe('a#1');
    expect(cache.peek('b')).toBe('b#2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('bounds the entries, evicting the least recently stored', async () => {
    const { load } = counting();
    const cache = createSwrCache({ ttlMs: 1_000, max: 2, load, now });
    await cache.get('a');
    await cache.get('b');
    await cache.get('c'); // evicts `a`
    expect(cache.peek('b')).toBe('b#2');
    expect(cache.peek('c')).toBe('c#3');
    expect(cache.peek('a')).toBeNull();
  });

  it('caches nothing when the loader rejects', async () => {
    const load = vi.fn(async () => {
      throw new Error('boom');
    });
    const cache = createSwrCache<string, string>({ ttlMs: 1_000, max: 10, load, now });
    await expect(cache.get('a')).rejects.toThrow('boom');
    expect(cache.peek('a')).toBeNull();
  });
});

describe('evictForgeProjectCaches', () => {
  const commented = (id: number) => ({
    event: 'commented',
    id,
    user: { login: 'someone', avatar_url: 'https://example.invalid/a.png' },
    created_at: `2026-01-0${id}T00:00:00Z`,
    body: `comment ${id}`,
    html_url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
  });

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    __clearCommentsCacheForTests();
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: JSON.stringify([commented(1)]), stderr: '' });
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  // Regression: the pre-#847 eviction cleared comments by a `${root}:` prefix while comment keys
  // are `${root}\0${kind}#${n}`, so a merged PR's thread was served from cache for another minute.
  it('drops the cached comment threads of that root, and only that root', async () => {
    await fetchGithubComments('/repo/evict-a', 'issue', 1);
    await fetchGithubComments('/repo/evict-b', 'issue', 1);
    expect(execFileMock).toHaveBeenCalledTimes(2);

    evictForgeProjectCaches('/repo/evict-a');

    await fetchGithubComments('/repo/evict-a', 'issue', 1);
    expect(execFileMock).toHaveBeenCalledTimes(3); // refetched
    await fetchGithubComments('/repo/evict-b', 'issue', 1);
    expect(execFileMock).toHaveBeenCalledTimes(3); // the other root is still cached
  });

  it('keeps evictGithubProjectCaches as a delegate', async () => {
    await fetchGithubComments('/repo/evict-c', 'issue', 1);
    evictGithubProjectCaches('/repo/evict-c');
    await fetchGithubComments('/repo/evict-c', 'issue', 1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

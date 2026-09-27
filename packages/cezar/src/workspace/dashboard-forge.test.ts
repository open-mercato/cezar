import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ repo: vi.fn(), driver: vi.fn(), recent: vi.fn() }));
vi.mock('../server/git.ts', () => ({
  getRepoInfo: mocks.repo,
  isNonRepositoryDirectory: async () => false,
}));
vi.mock('../server/forge/github.ts', () => ({ createGithubDriver: mocks.driver }));
const now = Date.parse('2026-09-18T12:00:00Z');
const item = (number = 1, createdAt = '2026-09-17T12:00:00Z') => ({
  number,
  createdAt,
  title: 'Created, then closed',
  url: `https://github.com/o/r/issues/${number}`,
});
async function reader() {
  return (await import('./dashboard-forge.ts')).getDashboardGithub;
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.repo
    .mockReset()
    .mockImplementation(async (root: string) => ({ root, remote: 'git@github.com:O/R.git' }));
  mocks.recent
    .mockReset()
    .mockResolvedValue({ available: true, items: [item()], truncated: false });
  mocks.driver.mockReset().mockReturnValue({ recentCreated: mocks.recent });
});
afterEach(() => vi.useRealTimers());
describe('dashboard GitHub source', () => {
  it('deduplicates canonical repositories, retains both project IDs and filters the exact window', async () => {
    mocks.repo.mockImplementation(async (root: string) => ({
      root,
      remote: root === '/a' ? 'git@github.com:O/R.git' : 'https://github.com/o/r',
    }));
    mocks.recent.mockResolvedValue({
      available: true,
      items: [item(), item(2, '2026-09-11T01:00:00Z')],
      truncated: false,
    });
    const get = await reader();
    const result = await get(
      [
        { id: 'a', root: '/a' },
        { id: 'b', root: '/b' },
      ],
      now,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.projectIds).toEqual(['a', 'b']);
    expect(result.sources.map((source) => source.key)).toEqual([
      'github:github.com/o/r:issue',
      'github:github.com/o/r:pr',
    ]);
    expect(mocks.recent).toHaveBeenCalledTimes(2);
    expect(mocks.recent).toHaveBeenCalledWith('issue', '2026-09-11');
  });
  it('coalesces requests and caches failures and successful kinds independently for 60 seconds', async () => {
    const get = await reader();
    const projects = [{ id: 'a', root: '/a' }];
    await Promise.all([get(projects, now), get(projects, now)]);
    await get(projects, now + 59_000);
    expect(mocks.recent).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now + 61_000);
    mocks.recent.mockImplementation(async (kind: string) =>
      kind === 'issue'
        ? { available: false, items: [], reason: 'Offline' }
        : { available: true, items: [item(3)], truncated: true },
    );
    const result = await get(projects, now + 61_000);
    expect(result.sources[0]).toMatchObject({
      state: 'stale',
      fetchedAt: new Date(now).toISOString(),
      reason: 'Offline',
    });
    expect(result.sources[1]).toMatchObject({ state: 'ready', truncated: true });
    await get(projects, now + 62_000);
    expect(mocks.recent).toHaveBeenCalledTimes(4);
  });
  it('bounds concurrent jobs to two and returns pending coverage after five seconds, then warms cache', async () => {
    mocks.repo.mockImplementation(async (root: string) => ({
      root,
      remote: `https://github.com/o/${root.slice(1)}`,
    }));
    const releases: (() => void)[] = [];
    mocks.recent.mockImplementation(
      () =>
        new Promise((resolve) =>
          releases.push(() => resolve({ available: true, items: [item()] })),
        ),
    );
    const get = await reader();
    const projects = ['a', 'b', 'c'].map((id) => ({ id, root: `/${id}` }));
    const request = get(projects, now);
    await vi.advanceTimersByTimeAsync(5_000);
    const pending = await request;
    expect(mocks.recent).toHaveBeenCalledTimes(2);
    expect(pending.sources).toHaveLength(6);
    expect(pending.sources.every((source) => source.reason === 'Still loading GitHub')).toBe(true);
    for (let index = 0; index < 6; index++) {
      releases[index]!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect((await get(projects, now + 5_000)).rows).toHaveLength(6);
    expect(mocks.recent).toHaveBeenCalledTimes(6);
  });
  it('invalidates date keys at midnight and evicts removed repositories', async () => {
    const get = await reader();
    const projects = [{ id: 'a', root: '/a' }];
    await get(projects, now);
    await get(projects, Date.parse('2026-09-19T00:00:00Z'));
    expect(mocks.recent).toHaveBeenCalledTimes(4);
    await get([], now);
    await get(projects, now);
    expect(mocks.recent).toHaveBeenCalledTimes(6);
  });
  it('cancels unsent work on disconnect without aborting another reader', async () => {
    mocks.repo.mockImplementation(async (root: string) => ({
      root,
      remote: `https://github.com/o/${root.slice(1)}`,
    }));
    const releases: (() => void)[] = [];
    mocks.recent.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve({ available: true, items: [] }))),
    );
    const get = await reader();
    const controller = new AbortController();
    const a = get(
      ['a', 'b', 'c'].map((id) => ({ id, root: `/${id}` })),
      now,
      controller.signal,
    );
    const b = get([{ id: 'a', root: '/a' }], now);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await a;
    releases[0]!();
    releases[1]!();
    await vi.advanceTimersByTimeAsync(0);
    releases[2]!();
    await b;
    expect(mocks.recent).toHaveBeenCalledTimes(3);
  });
});

it('keeps at most 100 cached repositories and does not lose response rows when LRU entries evict', async () => {
  mocks.repo.mockImplementation(async (root: string) => ({
    root,
    remote: `https://github.com/o/${root.slice(1)}`,
  }));
  const get = await reader();
  const projects = Array.from({ length: 101 }, (_, index) => ({
    id: String(index),
    root: `/r${index}`,
  }));
  await get(projects.slice(0, 100), now);
  expect(mocks.recent).toHaveBeenCalledTimes(200);
  const response = await get(projects, now);
  expect(response.rows).toHaveLength(202);
  expect(mocks.recent).toHaveBeenCalledTimes(202);
  await get([projects[100]!, ...projects.slice(0, 100)], now);
  expect(mocks.recent.mock.calls.length).toBeGreaterThan(202); // Oldest root was evicted.
});

it('reports missing remotes and per-kind failures without erasing good sources', async () => {
  mocks.repo.mockImplementation(async (root: string) =>
    root === '/missing' ? { root } : { root, remote: 'https://github.com/o/r' },
  );
  mocks.recent.mockImplementation(async (kind: string) =>
    kind === 'issue'
      ? { available: false, items: [], reason: 'Authentication required' }
      : { available: true, items: [item()], truncated: false },
  );
  const get = await reader();
  const result = await get(
    [
      { id: 'a', root: '/a' },
      { id: 'missing', root: '/missing' },
    ],
    now,
  );
  expect(result.rows).toHaveLength(1);
  expect(result.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: 'github:github.com/o/r:issue',
        state: 'unavailable',
        reason: 'Authentication required',
      }),
      expect.objectContaining({ key: 'github:github.com/o/r:pr', state: 'ready' }),
      expect.objectContaining({
        key: 'github:project:missing:issue',
        state: 'unavailable',
        reason: 'No GitHub remote',
      }),
    ]),
  );
});

it('includes remote discovery in its five-second response budget', async () => {
  mocks.repo.mockReturnValue(new Promise(() => {}));
  const get = await reader();
  const pending = get([{ id: 'slow', root: '/slow' }], now);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await pending).sources).toEqual([
    {
      key: 'github:project:slow:issue',
      state: 'unavailable',
      truncated: false,
      reason: 'Still loading GitHub',
    },
    {
      key: 'github:project:slow:pr',
      state: 'unavailable',
      truncated: false,
      reason: 'Still loading GitHub',
    },
  ]);
  expect(mocks.recent).not.toHaveBeenCalled();
});

it.each(['null', 'throw'])(
  'retains cached rows as stale after a %s repository probe failure and recovers',
  async (failure) => {
    const get = await reader();
    const projects = [{ id: 'a', root: '/a' }];
    const initial = await get(projects, now);
    if (failure === 'null') mocks.repo.mockResolvedValue(null);
    else mocks.repo.mockRejectedValue(new Error('Root unavailable'));
    const result = await get(projects, now + 1_000);
    expect(result.rows).toEqual(initial.rows);
    expect(result.sources).toHaveLength(2);
    for (const source of result.sources) {
      expect(source).toMatchObject({
        state: 'stale',
        fetchedAt: new Date(now).toISOString(),
        reason: 'Could not read GitHub repository',
      });
    }
    expect(mocks.recent).toHaveBeenCalledTimes(2);
    mocks.repo.mockResolvedValue({ root: '/a', remote: 'https://github.com/o/r' });
    const recovered = await get(projects, now + 2_000);
    expect(recovered.rows).toEqual(initial.rows);
    expect(recovered.sources.every((source) => source.state === 'ready' && !source.reason)).toBe(true);
  },
);

it('reports a failed probe without a cached identity as unavailable, not a missing remote', async () => {
  mocks.repo.mockResolvedValue(null);
  const get = await reader();
  const result = await get([{ id: 'a', root: '/a' }], now);
  expect(result.rows).toEqual([]);
  expect(result.sources).toEqual([
    {
      key: 'github:project:a:issue',
      state: 'unavailable',
      truncated: false,
      reason: 'Could not read GitHub repository',
    },
    {
      key: 'github:project:a:pr',
      state: 'unavailable',
      truncated: false,
      reason: 'Could not read GitHub repository',
    },
  ]);
});

it.each([undefined, 'https://gitlab.com/o/r', 'https://github.internal/o/r'])(
  'forgets an absent or unsupported remote (%s) while another project caches the old repository',
  async (remote) => {
    const get = await reader();
    const projects = [{ id: 'a', root: '/a' }, { id: 'b', root: '/b' }];
    await get(projects, now);
    mocks.repo.mockImplementation(async (root: string) =>
      root === '/a' ? { root, remote } : { root, remote: 'https://github.com/o/r' },
    );
    const removed = await get(projects, now + 1_000);
    expect(removed.rows).toHaveLength(2);
    expect(removed.rows.every((row) => row.projectIds.join() === 'b')).toBe(true);
    expect(removed.sources.find((source) => source.key === 'github:project:a:issue')?.reason)
      .toBe('No GitHub remote');
    mocks.repo.mockImplementation(async (root: string) =>
      root === '/a' ? null : { root, remote: 'https://github.com/o/r' },
    );
    const unavailable = await get(projects, now + 2_000);
    expect(unavailable.rows).toHaveLength(2);
    expect(unavailable.rows.every((row) => row.projectIds.join() === 'b')).toBe(true);
    expect(unavailable.sources.find((source) => source.key === 'github:project:a:issue')?.reason)
      .toBe('Could not read GitHub repository');
  },
);

it('retains only the latest remote after a rename followed by a probe outage', async () => {
  const get = await reader();
  const projects = [{ id: 'a', root: '/a' }, { id: 'b', root: '/b' }];
  await get(projects, now);
  mocks.repo.mockImplementation(async (root: string) => ({
    root,
    remote: `https://github.com/o/${root === '/a' ? 'renamed' : 'r'}`,
  }));
  const renamed = await get(projects, now + 1_000);
  expect(renamed.rows.filter((row) => row.repo === 'github.com/o/r')
    .every((row) => row.projectIds.join() === 'b')).toBe(true);
  mocks.repo.mockImplementation(async (root: string) =>
    root === '/a' ? null : { root, remote: 'https://github.com/o/r' },
  );
  const unavailable = await get(projects, now + 2_000);
  expect(unavailable.rows.filter((row) => row.repo === 'github.com/o/renamed')).toHaveLength(2);
  expect(unavailable.rows.filter((row) => row.repo === 'github.com/o/r')
    .every((row) => row.projectIds.join() === 'b')).toBe(true);
  expect(unavailable.sources.find((source) => source.key === 'github:github.com/o/renamed:issue'))
    .toMatchObject({ state: 'stale', reason: 'Could not read GitHub repository' });
});


it('retains cached rows as stale while repository discovery exceeds the response deadline', async () => {
  const get = await reader();
  const projects = [{ id: 'a', root: '/a' }];
  const initial = await get(projects, now);
  let release!: (value: { root: string; remote?: string }) => void;
  mocks.repo.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const pending = get(projects, now);
  await vi.advanceTimersByTimeAsync(5_000);
  const result = await pending;
  expect(result.rows).toEqual(initial.rows);
  expect(result.sources).toHaveLength(2);
  expect(result.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'github:github.com/o/r:issue', state: 'stale', reason: 'Still loading GitHub' }),
    expect.objectContaining({ key: 'github:github.com/o/r:pr', state: 'stale', reason: 'Still loading GitHub' }),
  ]));
  release({ root: '/a' });
  await vi.advanceTimersByTimeAsync(0);
  const detached = await get(projects, now + 5_000);
  expect(detached.rows).toEqual([]);
  expect(detached.sources.every((source) => source.reason === 'No GitHub remote')).toBe(true);
});


it.each(['detached', 'confirmed'])(
  'keeps a pending cached sibling without overriding a %s repository probe',
  async (outcome) => {
    const get = await reader();
    const projects = [{ id: 'a', root: '/a' }, { id: 'b', root: '/b' }];
    await get(projects, now);
    const controller = new AbortController();
    mocks.repo.mockImplementation((root: string) => root === '/b'
      ? new Promise(() => {})
      : Promise.resolve({ root, ...(outcome === 'confirmed' ? { remote: 'https://github.com/o/r' } : {}) }));
    const pending = get(projects, now, controller.signal);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    controller.abort();
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.projectIds).toEqual(outcome === 'confirmed' ? ['a', 'b'] : ['b']);
    expect(result.sources.find((source) => source.key === 'github:github.com/o/r:issue'))
      .toMatchObject(outcome === 'confirmed'
        ? { state: 'ready' }
        : { state: 'stale', reason: 'Still loading GitHub' });
    if (outcome === 'detached')
      expect(result.sources.find((source) => source.key === 'github:project:a:issue')?.reason)
        .toBe('No GitHub remote');
  },
);

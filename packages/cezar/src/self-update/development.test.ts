import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOpenPulls, OpenPullsCache, pullOfVersion, type OpenPull, type OpenPulls } from './pulls.ts';
import { RegistryCache } from './registry.ts';
import { SelfUpdateService } from './service.ts';

const pull = (number: number, updatedAt: string, branch = `feat/${number}`): OpenPull => ({
  number,
  title: `PR ${number}`,
  author: 'someone',
  branch,
  draft: false,
  updatedAt,
  url: `https://github.com/open-mercato/cezar/pull/${number}`,
});

describe('open pull requests', () => {
  it('reads the PR a preview version was cut for', () => {
    expect(pullOfVersion('0.13.0-pr1169.1300')).toBe(1169);
    expect(pullOfVersion('0.9.2-pr743.1156.2')).toBe(743);
    expect(pullOfVersion('0.13.0-nightly.20260929.55')).toBeNull();
    expect(pullOfVersion('0.13.0')).toBeNull();
  });

  it('asks gh first, newest update first', async () => {
    const result = await fetchOpenPulls('o/r', { env: {}, gh: async () => [pull(1, '2026-09-01T00:00:00Z'), pull(2, '2026-09-02T00:00:00Z')] });
    expect(result).toEqual({ available: true, items: [pull(2, '2026-09-02T00:00:00Z'), pull(1, '2026-09-01T00:00:00Z')] });
  });

  it('falls back to the GitHub REST API when gh cannot answer, with GITHUB_TOKEN when set', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json([
        { number: 7, title: 'Seven', user: { login: 'a' }, head: { ref: 'feat/7' }, draft: true, updated_at: '2026-09-03T00:00:00Z', html_url: 'u7' },
      ]),
    );
    const result = await fetchOpenPulls('o/r', {
      env: { GITHUB_TOKEN: 'tok' },
      gh: async () => {
        throw new Error('spawn gh ENOENT');
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.items).toEqual([{ number: 7, title: 'Seven', author: 'a', branch: 'feat/7', draft: true, updatedAt: '2026-09-03T00:00:00Z', url: 'u7' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/repos/o/r/pulls?state=open');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('degrades to an empty list with a reason, never an error', async () => {
    const result = await fetchOpenPulls('o/r', {
      env: {},
      gh: async () => {
        throw new Error('gh: not logged in');
      },
      fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
    });
    expect(result.available).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.reason).toContain('gh: not logged in');
    expect(result.reason).toContain('403');
    expect((await fetchOpenPulls('o/r', { env: { CEZ_DRY_RUN: '1' } })).available).toBe(false);
  });

  it('keeps the last good list over a failed refresh', async () => {
    const answers: OpenPulls[] = [
      { available: true, items: [pull(1, '2026-09-01T00:00:00Z')] },
      { available: false, reason: 'offline', items: [] },
    ];
    const cache = new OpenPullsCache(async () => answers.shift()!);
    expect((await cache.get()).items).toHaveLength(1);
    expect((await cache.get(true)).items).toHaveLength(1);
  });
});

describe('development channel', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-dev-channel-'));
    env = { ...process.env, CEZ_HOME: home, CEZ_UPDATE_CHANNEL: 'development' };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const registry = () =>
    new RegistryCache('@open-mercato/cezar', (async () =>
      Response.json({
        'dist-tags': { latest: '0.14.0', nightly: '0.14.1-nightly.20260929.1', 'pr-11': '0.13.0-pr11.500', 'pr-3': '0.9.0-pr3.10' },
        versions: { '0.14.0': {}, '0.13.0': {}, '0.13.0-pr11.500': {}, '0.9.0-pr3.10': {} },
        time: { '0.13.0-pr11.500': '2026-09-29T12:00:00.000Z' },
      })) as typeof fetch);

  const service = () =>
    new SelfUpdateService({
      pkgName: '@open-mercato/cezar',
      version: '0.13.0',
      entry: join(home, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js'),
      restart: () => {},
      env,
      registry: registry(),
      pulls: async () => ({ available: true, items: [pull(12, '2026-09-29T13:00:00Z'), pull(11, '2026-09-29T11:00:00Z')] }),
    });

  it('never offers an update, however new the releases are', async () => {
    const svc = service();
    expect(await svc.channel()).toBe('development');
    expect(await svc.updateAvailable(true)).toBeNull();
    expect((await svc.status({ refresh: true })).updateAvailable).toBeNull();
  });

  // Only OPEN PRs are listed: `pr-3`'s tag outlived its PR (it predates the cleanup job).
  it('joins open PRs with their preview builds', async () => {
    const dev = await service().development({ refresh: true });
    expect(dev.pulls.available).toBe(true);
    expect(dev.pulls.items.map((item) => [item.number, item.version, item.publishedAt, item.installed])).toEqual([
      [12, null, null, false],
      [11, '0.13.0-pr11.500', '2026-09-29T12:00:00.000Z', false],
    ]);
  });

  it('lists no worktrees in hosted mode', async () => {
    const svc = new SelfUpdateService({
      pkgName: '@open-mercato/cezar',
      version: '0.13.0',
      entry: '/x/dist/index.js',
      restart: () => {},
      env,
      registry: registry(),
      trimPaths: () => true,
      pulls: async () => ({ available: true, items: [] }),
    });
    expect((await svc.development()).checkouts).toEqual([]);
  });
});

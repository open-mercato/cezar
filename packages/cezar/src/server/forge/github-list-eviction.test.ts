import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
import { evictGithubProjectCaches, fetchGithub } from './github.ts';

type Reply = (error: null, result: { stdout: string; stderr: string }) => void;
let lists: Reply[];

function reply(callback: Reply, title: string): void {
  callback(null, { stdout: JSON.stringify([{
    number: 1, title, createdAt: '2026-10-01T00:00:00Z', labels: [],
    body: '', url: 'https://github.com/acme/demo/issues/1',
  }]), stderr: '' });
}

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  lists = [];
  execFile.mockImplementation((_file, args: string[], _opts, callback: Reply) => {
    if (args[0] === 'issue') { lists.push(callback); return; }
    callback(null, { stdout: args[0] === 'repo' ? 'acme/demo' : '[]', stderr: '' });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('GitHub list invalidation', () => {
  it.each(['stale first', 'fresh first'])('detaches an evicted list fetch and prevents stale cache writes (%s)', async (order) => {
    const root = `/list-eviction/${order}`;
    const stale = fetchGithub(root);
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    evictGithubProjectCaches(root);
    const fresh = fetchGithub(root);
    await vi.waitFor(() => expect(lists).toHaveLength(2));
    let reader;
    if (order === 'stale first') {
      reply(lists[0]!, 'stale');
      expect((await stale).issues[0]?.title).toBe('stale');
      reader = fetchGithub(root);
      reply(lists[1]!, 'fresh');
    } else {
      reply(lists[1]!, 'fresh');
      expect((await fresh).issues[0]?.title).toBe('fresh');
      reply(lists[0]!, 'stale');
      await stale;
      reader = fetchGithub(root);
    }
    expect((await fresh).issues[0]?.title).toBe('fresh');
    expect((await reader).issues[0]?.title).toBe('fresh');
    expect((await fetchGithub(root)).issues[0]?.title).toBe('fresh');
    expect(lists).toHaveLength(2);
  });

  it('does not repopulate the cache when an evicted fetch finishes before the next reader', async () => {
    const root = '/list-eviction/completed';
    const stale = fetchGithub(root);
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    evictGithubProjectCaches(root);
    reply(lists[0]!, 'stale');
    await stale;
    const fresh = fetchGithub(root);
    await vi.waitFor(() => expect(lists).toHaveLength(2));
    reply(lists[1]!, 'fresh');
    expect((await fresh).issues[0]?.title).toBe('fresh');
  });

  it('lets an explicit refresh supersede a passive fetch', async () => {
    const root = '/list-eviction/refresh';
    const stale = fetchGithub(root);
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    const fresh = fetchGithub(root, true);
    await vi.waitFor(() => expect(lists).toHaveLength(2));
    reply(lists[1]!, 'fresh');
    await fresh;
    reply(lists[0]!, 'stale');
    await stale;
    expect((await fetchGithub(root)).issues[0]?.title).toBe('fresh');
    expect(lists).toHaveLength(2);
  });
});

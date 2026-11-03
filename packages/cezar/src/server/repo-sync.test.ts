import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoSync, RepoSyncActionResponse } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { fetchRepo, parseTrack, pullRepo, pushRepo, repoSyncStatus, syncRepo } from './repo-sync.ts';
import { createApp } from './server.ts';

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function identity(dir: string): void {
  g(dir, 'config', 'user.email', 'test@cezar.local');
  g(dir, 'config', 'user.name', 'cezar-test');
  g(dir, 'config', 'commit.gpgsign', 'false');
}

function commit(dir: string, file: string, message: string): void {
  writeFileSync(join(dir, file), `${message}\n`);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', message);
}

describe('parseTrack', () => {
  it('reads git\'s %(upstream:track) forms', () => {
    expect(parseTrack('', false)).toEqual({ ahead: null, behind: null, gone: false });
    expect(parseTrack('', true)).toEqual({ ahead: 0, behind: 0, gone: false });
    expect(parseTrack('[ahead 2, behind 3]', true)).toEqual({ ahead: 2, behind: 3, gone: false });
    expect(parseTrack('[behind 1]', true)).toEqual({ ahead: 0, behind: 1, gone: false });
    expect(parseTrack('[gone]', true)).toEqual({ ahead: null, behind: null, gone: true });
  });
});

describe('repo sync — the main checkout against a local bare origin', () => {
  let base: string;
  let remote: string;
  let repo: string;
  let peer: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN;
    base = mkdtempSync(join(tmpdir(), 'cez-sync-'));
    remote = join(base, 'origin.git');
    repo = join(base, 'repo');
    peer = join(base, 'peer');
    g(base, 'init', '-q', '--bare', '-b', 'main', remote);
    g(base, 'clone', '-q', remote, repo);
    identity(repo);
    g(repo, 'checkout', '-q', '-b', 'main');
    commit(repo, 'a.txt', 'first');
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    g(base, 'clone', '-q', remote, peer);
    identity(peer);
  });

  afterEach(async () => {
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    await removeTempDir(base);
  });

  it('a checkout level with its upstream reports zero both ways', async () => {
    const s = await repoSyncStatus(repo);
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, outgoing: [], incoming: [] });
    expect(s.pushRemote).toBe('origin');
    expect(s.branches).toEqual([{ name: 'main', upstream: 'origin/main', ahead: 0, behind: 0, gone: false }]);
  });

  it('shows outgoing commits, and incoming ones only after a fetch (offline status)', async () => {
    commit(repo, 'b.txt', 'local work');
    commit(peer, 'c.txt', 'teammate work');
    g(peer, 'push', '-q');

    let s = await repoSyncStatus(repo);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
    expect(s.outgoing).toHaveLength(1);

    expect(await fetchRepo(repo)).toEqual({ ok: true, message: 'fetched' });
    s = await repoSyncStatus(repo);
    expect(s).toMatchObject({ ahead: 1, behind: 1 });
    expect(s.incoming.map((c) => c.subject)).toEqual(['teammate work']);
    expect(s.lastFetchedAt).not.toBeNull();
  });

  it('pull fast-forwards, and refuses a diverged branch instead of merging', async () => {
    commit(peer, 'c.txt', 'teammate work');
    g(peer, 'push', '-q');
    expect(await pullRepo(repo)).toEqual({ ok: true, message: 'pulled 1 commit' });
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('teammate work');
    expect(await pullRepo(repo)).toEqual({ ok: true, message: 'already up to date' });

    commit(peer, 'd.txt', 'more teammate work');
    g(peer, 'push', '-q');
    commit(repo, 'e.txt', 'my work');
    const diverged = await pullRepo(repo);
    expect(diverged.ok).toBe(false);
    expect(!diverged.ok && diverged.error).toContain('has diverged');
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('my work');
  });

  // telemetry 9202a06a: git's raw `error:` line (or a push's `To <remote>`) reached the toast.
  it('says what to do when a push is rejected or a pull would overwrite local changes', async () => {
    commit(peer, 'a.txt', 'teammate edit');
    g(peer, 'push', '-q');
    commit(repo, 'b.txt', 'my work');
    expect(await pushRepo(repo)).toEqual({ ok: false, error: 'the remote has commits this branch does not — pull first' });

    g(repo, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(repo, 'a.txt'), 'uncommitted\n');
    expect(await pullRepo(repo)).toEqual({
      ok: false,
      error: 'uncommitted changes would be overwritten — commit or stash them first',
    });
  });

  it('push publishes a branch with no upstream, which status lists as all-outgoing first', async () => {
    g(repo, 'checkout', '-q', '-b', 'feat/x');
    commit(repo, 'f.txt', 'feature');
    let s = await repoSyncStatus(repo);
    expect(s).toMatchObject({ branch: 'feat/x', upstream: null, ahead: null, behind: null });
    expect(s.outgoing).toHaveLength(1);

    expect(await pushRepo(repo)).toEqual({ ok: true, message: 'published feat/x to origin' });
    s = await repoSyncStatus(repo);
    expect(s).toMatchObject({ upstream: 'origin/feat/x', ahead: 0, behind: 0, outgoing: [] });
  });

  it('sync pulls then pushes', async () => {
    commit(peer, 'c.txt', 'teammate work');
    g(peer, 'push', '-q');
    expect((await syncRepo(repo)).ok).toBe(true);
    commit(repo, 'b.txt', 'local work');
    expect(await syncRepo(repo)).toEqual({ ok: true, message: 'synced' });
    expect(g(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe('local work');
  });

  it('CEZ_DRY_RUN=1 never touches the network', async () => {
    process.env.CEZ_DRY_RUN = '1';
    commit(repo, 'b.txt', 'local work');
    expect(await fetchRepo(repo)).toEqual({ ok: true, message: 'dry run — fetch skipped' });
    expect(await pushRepo(repo)).toEqual({ ok: true, message: 'dry run — push skipped' });
    expect(g(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe('first');
  });

  describe('routes', () => {
    let store: RunStore;
    let app: Hono;

    beforeEach(() => {
      writeFileSync(join(repo, '.gitignore'), '.ai/\n');
      g(repo, 'add', '-A');
      g(repo, 'commit', '-q', '-m', 'ignore state');
      store = RunStore.open(join(repo, '.ai/cezar'));
      app = createApp({ repoRoot: repo, store, manager: {} as unknown as RunManager, version: '0.0.0-test' });
    });

    afterEach(() => store.flush());

    it('GET /api/v1/repo/sync answers the status', async () => {
      const res = await apiRequest(app, '/api/v1/repo/sync');
      expect(res.status).toBe(200);
      expect(((await res.json()) as RepoSync)).toMatchObject({ branch: 'main', ahead: 1, behind: 0 });
    });

    it('POST /api/v1/repo/push returns the fresh status; a predictable failure is a 409', async () => {
      const res = await apiRequest(app, '/api/v1/repo/push', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RepoSyncActionResponse;
      expect(body.message).toBe('pushed main');
      expect(body.sync).toMatchObject({ ahead: 0, behind: 0 });

      g(repo, 'checkout', '-q', '-b', 'lonely');
      const pull = await apiRequest(app, '/api/v1/repo/pull', { method: 'POST' });
      expect(pull.status).toBe(409);
      expect(((await pull.json()) as { error: string }).error).toContain('no upstream');
    });
  });
});

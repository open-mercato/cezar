import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from './git-worktree.ts';
import { RunStore, type RunRecord } from './runs/store.ts';
import { createApp } from './server/server.ts';
import type { RunManager } from './workflows/run.ts';
import { parseOlderThan, runWorktreesCommand, type WorktreesCliIo } from './worktrees-cli.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const DAY = 86_400_000;

describe('cez worktrees', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-wtcli-')));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir, { keepLive: true });
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function seed(status: RunRecord['status'], patch: Partial<RunRecord> = {}): Promise<string> {
    const rec = store.createRun({ title: `${status} task`, workflow: 'w', task: 't', steps: [] });
    const wt = await createWorktree(repoRoot, rec.id, 'main');
    store.updateRun(rec.id, { status, worktreePath: wt.path, branch: wt.branch, ...patch });
    store.flush();
    return rec.id;
  }

  function io(extra: Partial<WorktreesCliIo> = {}): WorktreesCliIo {
    return {
      fetch: (() => { throw new Error('offline tests must not fetch'); }) as unknown as typeof fetch,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      cwd: repoRoot,
      env: {},
      cockpits: async () => ({ origins: [], unverified: [] }),
      holders: async () => [],
      ...extra,
    };
  }

  const reread = () => RunStore.open(dataDir, { keepLive: true });

  describe('offline (no cockpit)', () => {
    it('list shows every tree with status, size and reclaimable, plus the total', async () => {
      const done = await seed('done');
      const running = await seed('running');
      expect(await runWorktreesCommand(['list'], io())).toBe(0);
      const text = out.join('\n');
      expect(text).toMatch(/RUN\s+STATUS\s+LAST ACTIVITY\s+SIZE\s+RECLAIMABLE\s+TITLE/);
      expect(text).toMatch(new RegExp(`${done.slice(0, 8)}\\s+done\\s+\\S+ ago\\s+\\S+ \\S+\\s+yes`));
      expect(text).toMatch(new RegExp(`${running.slice(0, 8)}\\s+running\\s+.*\\s+no\\s+running task`));
      expect(text).toMatch(/2 worktrees, .* total · 1 reclaimable/);
      expect(text).toContain('no cockpit running');

      out = [];
      expect(await runWorktreesCommand(['list', '--json'], io())).toBe(0);
      const json = JSON.parse(out.join('\n')) as { worktrees: Array<{ runId: string; reclaimable: boolean }>; idleDays: number };
      expect(json.worktrees.map((w) => [w.runId, w.reclaimable]).sort()).toEqual([[done, true], [running, false]].sort());
      expect(json.idleDays).toBe(7);
    });

    it('reclaim --dry-run reports the candidates and touches nothing', async () => {
      const done = await seed('done');
      const review = await seed('review');
      const now = () => Date.now() + 10 * DAY;
      expect(await runWorktreesCommand(['reclaim', '--all-inactive', '--dry-run'], io({ now }))).toBe(0);
      expect(out[0]).toMatch(/^would reclaim 2 worktrees inactive, .* \(dry run: nothing was removed\)/);
      expect(out.join('\n')).toContain(done.slice(0, 8));
      const after = reread();
      for (const id of [done, review]) {
        expect(existsSync(after.getRun(id)!.worktreePath!)).toBe(true);
        expect(after.getRun(id)!.worktreeReclaimedAt).toBeUndefined();
      }
    });

    it('reclaim --older-than picks only trees idle that long and keeps their branches', async () => {
      const old = await seed('review');
      const running = await seed('running');
      // Nothing is a day old yet.
      expect(await runWorktreesCommand(['reclaim', '--older-than', '1d'], io())).toBe(0);
      expect(out.join('\n')).toContain('nothing to reclaim');

      out = [];
      const now = () => Date.now() + 3 * DAY;
      expect(await runWorktreesCommand(['reclaim', '--older-than', '48h'], io({ now }))).toBe(0);
      expect(out[0]).toMatch(/^reclaimed 1 worktree inactive for over 48h/);
      const after = reread();
      expect(after.getRun(old)!.worktreeReclaimedAt).toBeTruthy();
      expect(existsSync(after.getRun(old)!.worktreePath!)).toBe(false);
      expect((await run('git', ['branch', '--list', after.getRun(old)!.branch!], { cwd: repoRoot })).stdout).toContain('cez/');
      expect(existsSync(after.getRun(running)!.worktreePath!)).toBe(true);
    });

    it('rejects a malformed --older-than and conflicting selectors', async () => {
      expect(parseOlderThan('7d')).toBe(7);
      expect(parseOlderThan('12h')).toBe(0.5);
      expect(parseOlderThan('3')).toBe(3);
      expect(await runWorktreesCommand(['reclaim', '--older-than', 'soon'], io())).toBe(2);
      expect(await runWorktreesCommand(['reclaim', '--older-than', '7d', '--all-inactive'], io())).toBe(2);
    });

    it('remove refuses active runs with a clear message and a non-zero exit', async () => {
      const running = await seed('running');
      const queued = await seed('queued');
      const parked = await seed('waiting');
      for (const id of [running, queued, parked]) {
        err = [];
        expect(await runWorktreesCommand(['remove', id.slice(0, 8)], io())).toBe(1);
        expect(err.join('\n')).toMatch(/refusing to remove .*: the task is (running|queued|waiting with a parked session)/);
        expect(existsSync(reread().getRun(id)!.worktreePath!)).toBe(true);
      }
    });

    it('remove reclaims one inactive run by id prefix', async () => {
      const done = await seed('done');
      expect(await runWorktreesCommand(['remove', done.slice(0, 6)], io())).toBe(0);
      expect(out.join('\n')).toMatch(/removed .*'s worktree .* Continue restores it/);
      expect(reread().getRun(done)!.worktreeReclaimedAt).toBeTruthy();
      // A second remove has nothing left to do.
      out = [];
      expect(await runWorktreesCommand(['remove', done], io())).toBe(0);
      expect(out.join('\n')).toContain('already reclaimed');
      expect(await runWorktreesCommand(['remove', 'zzzz'], io())).toBe(1);
    });

    it('remove refuses a tree a running process uses', async () => {
      const done = await seed('done');
      const path = store.getRun(done)!.worktreePath!;
      const holders = async () => [{ path, reason: 'node (pid 42)' }];
      expect(await runWorktreesCommand(['remove', done], io({ holders }))).toBe(1);
      expect(err.join('\n')).toContain('a running process uses it (node (pid 42))');
      expect(existsSync(path)).toBe(true);
    });

    it('prune removes orphan tree directories and keeps owned ones', async () => {
      const done = await seed('done');
      const orphan = '99999999-9999-4999-8999-999999999999';
      const orphanTree = await createWorktree(repoRoot, orphan, 'main');
      expect(await runWorktreesCommand(['prune'], io())).toBe(0);
      expect(out.join('\n')).toContain('removed 1 orphan worktree: 99999999');
      expect(existsSync(orphanTree.path)).toBe(false);
      expect(existsSync(store.getRun(done)!.worktreePath!)).toBe(true);
    });

    it('prune --archived-older-than previews with --dry-run, then deletes the archived task', async () => {
      const archivedAt = new Date(Date.now() - 200 * DAY).toISOString();
      const old = await seed('done', { archived: true, archivedAt });
      const recent = await seed('done', { archived: true, archivedAt: new Date().toISOString() });
      expect(await runWorktreesCommand(['prune', '--archived-older-than', '90d', '--dry-run'], io())).toBe(0);
      expect(out.join('\n')).toContain(`would delete 1 task archived over 90d: ${old.slice(0, 8)}`);
      expect(reread().getRun(old)).toBeDefined();

      out = [];
      expect(await runWorktreesCommand(['prune', '--archived-older-than', '90d'], io())).toBe(0);
      expect(out.join('\n')).toContain(`deleted 1 task archived over 90d: ${old.slice(0, 8)}`);
      expect(reread().getRun(old)).toBeUndefined();
      expect(reread().getRun(recent)).toBeDefined();
    });

    it('prune --dry-run without --archived-older-than is refused', async () => {
      expect(await runWorktreesCommand(['prune', '--dry-run'], io())).toBe(2);
      expect(await runWorktreesCommand(['prune', '--archived-older-than', '0d', '--dry-run'], io())).toBe(2);
      expect(err.join('\n')).toContain('must be more than 0');
    });

    it('refuses to write behind a cockpit it could not verify', async () => {
      await seed('done');
      const cockpits = async () => ({ origins: [], unverified: ['pid 7: health answered 500'] });
      expect(await runWorktreesCommand(['prune'], io({ cockpits }))).toBe(1);
      expect(err.join('\n')).toContain('could not be reached');
      // Reading is still fine.
      expect(await runWorktreesCommand(['list'], io({ cockpits }))).toBe(0);
    });

    it('refuses to write behind a verified cockpit whose project list fails, and still reads', async () => {
      await seed('done');
      const cockpits = async () => ({ origins: ['http://127.0.0.1:5555'], unverified: [] });
      const answers: Array<() => Promise<Response>> = [
        async () => new Response('boom', { status: 500 }),
        async () => new Response('not json', { status: 200 }),
        async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
      ];
      for (const answer of answers) {
        err = [];
        const fetcher = (() => answer()) as unknown as typeof fetch;
        expect(await runWorktreesCommand(['prune'], io({ cockpits, fetch: fetcher }))).toBe(1);
        expect(err.join('\n')).toContain('could not be reached');
        expect(await runWorktreesCommand(['list'], io({ cockpits, fetch: fetcher }))).toBe(0);
      }
    });
  });

  describe('through a running cockpit', () => {
    let app: Hono;
    let calls: string[];

    beforeEach(() => {
      const lifecycle = { requiresGate: async () => false, reclaim: async () => false, allowOrphanPrune: async () => true };
      app = createApp({
        repoRoot,
        store,
        manager: { isActive: () => false, lifecycle } as unknown as RunManager,
        version: '0.0.0-test',
      });
      calls = [];
    });

    function cockpitIo(extra: Partial<WorktreesCliIo> = {}): WorktreesCliIo {
      const fetcher = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        const headers = new Headers(init?.headers);
        headers.set('host', '127.0.0.1:4321');
        return app.request(url.pathname + url.search, { ...init, headers });
      }) as typeof fetch;
      return io({
        fetch: fetcher,
        env: { CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_PROJECT_ID: 'default' },
        ...extra,
      });
    }

    it('list reads GET /worktrees', async () => {
      const done = await seed('done');
      expect(await runWorktreesCommand(['list'], cockpitIo())).toBe(0);
      expect(calls).toEqual(['GET /api/v1/p/default/worktrees']);
      expect(out.join('\n')).toContain(done.slice(0, 8));
      expect(out.join('\n')).not.toContain('no cockpit running');
    });

    it('reclaim --dry-run asks the cockpit for a dry run and removes nothing', async () => {
      const done = await seed('done');
      expect(await runWorktreesCommand(['reclaim', '--all-inactive', '--dry-run'], cockpitIo())).toBe(0);
      expect(calls).toContain('POST /api/v1/p/default/worktrees/reclaim');
      expect(out[0]).toMatch(/^would reclaim 1 worktree/);
      expect(existsSync(store.getRun(done)!.worktreePath!)).toBe(true);
    });

    it('remove refuses a running run and reclaims an inactive one', async () => {
      const running = await seed('running');
      const done = await seed('done');
      expect(await runWorktreesCommand(['remove', running], cockpitIo())).toBe(1);
      expect(err.join('\n')).toContain('the task is running — cancel it first');
      expect(calls.some((c) => c.startsWith('POST'))).toBe(false);

      expect(await runWorktreesCommand(['remove', done.slice(0, 8)], cockpitIo())).toBe(0);
      expect(store.getRun(done)!.worktreeReclaimedAt).toBeTruthy();
      expect(existsSync(store.getRun(done)!.worktreePath!)).toBe(false);
    });

    it('lists from a cockpit that predates age retention but never sends it a selective reclaim', async () => {
      const posts: string[] = [];
      const legacyFetch = (async (input: string | URL, init?: RequestInit) => {
        if (init?.method === 'POST') posts.push(String(input));
        if (String(input).endsWith('/runs')) return Response.json([{ id: 'aaaaaaaa-1', status: 'done' }]);
        const worktrees = [{ runId: 'aaaaaaaa-1', title: 't', status: 'done', branch: null, sizeBytes: 1024, finishedAt: null, reclaimable: true }];
        return Response.json({ worktrees, totalBytes: 1024, keep: 10 });
      }) as typeof fetch;
      const legacy = io({ fetch: legacyFetch, env: { CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_PROJECT_ID: 'default' } });
      expect(await runWorktreesCommand(['list'], legacy)).toBe(0);
      expect(out.join('\n')).toContain('aaaaaaaa');
      expect(await runWorktreesCommand(['reclaim', '--dry-run'], legacy)).toBe(1);
      expect(err.join('\n')).toContain('older than this CLI');
      err = [];
      expect(await runWorktreesCommand(['remove', 'aaaaaaaa'], legacy)).toBe(1);
      expect(err.join('\n')).toContain('older than this CLI');
      expect(posts).toEqual([]);
    });

    it('prune --archived-older-than --dry-run asks the cockpit and deletes nothing', async () => {
      const old = await seed('done', { archived: true, archivedAt: new Date(Date.now() - 200 * DAY).toISOString() });
      expect(await runWorktreesCommand(['prune', '--archived-older-than', '90d', '--dry-run'], cockpitIo())).toBe(0);
      expect(calls).toEqual(['POST /api/v1/p/default/runs/archived/delete-expired']);
      expect(out.join('\n')).toContain(`would delete 1 task archived over 90d: ${old.slice(0, 8)}`);
      expect(store.getRun(old)).toBeDefined();
    });

    it('--project skips the CEZ_PROJECT_ID shortcut and finds the project by its root', async () => {
      const done = await seed('done');
      const projects = {
        projects: [{ id: 'abc', name: 'r', root: repoRoot, addedAt: 'x', lastOpenedAt: 'x', source: 'local', status: 'ok' }],
        bootProject: 'default',
        projectsDir: '/x',
      };
      const fetcher = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/api/v1/projects') return Response.json(projects);
        const headers = new Headers(init?.headers);
        headers.set('host', '127.0.0.1:4321');
        return app.request(url.pathname.replace('/p/abc/', '/p/default/'), { ...init, headers });
      }) as typeof fetch;
      expect(await runWorktreesCommand(['list', '--project', repoRoot], cockpitIo({ fetch: fetcher }))).toBe(0);
      expect(calls).toEqual(['GET /api/v1/projects', 'GET /api/v1/p/abc/worktrees']);
      expect(out.join('\n')).toContain(done.slice(0, 8));
    });

    it('prune goes through POST /worktrees/prune', async () => {
      const orphan = await createWorktree(repoRoot, '88888888-8888-4888-8888-888888888888', 'main');
      expect(await runWorktreesCommand(['prune'], cockpitIo())).toBe(0);
      expect(calls).toEqual(['POST /api/v1/p/default/worktrees/prune']);
      expect(out.join('\n')).toContain('removed 1 orphan worktree: 88888888');
      expect(existsSync(orphan.path)).toBe(false);
    });
  });
});

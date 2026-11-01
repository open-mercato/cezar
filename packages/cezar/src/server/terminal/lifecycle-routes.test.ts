import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../../runs/store.ts';
import { removeTempDir } from '../../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../../workspace/projects.ts';
import { apiRequest } from '../loopback-request.testkit.ts';
import { ProjectContexts } from '../project-context.ts';
import { createApp, type ServerDeps } from '../server.ts';
import { createSocketHub } from '../ws.ts';
import type { PtyBinding, PtyProcess } from './pty-module.ts';
import { TerminalSessions } from './sessions.ts';

/**
 * Every path that archives a task or takes its worktree away stops its terminals (spec
 * `.ai/specs/2026-10-07-task-workspace.md` §6). The single-run archive and delete are covered in
 * `terminal-routes.test.ts`; these are the paths that were missed.
 */

class FakePty implements PtyProcess {
  // Above any real pid on darwin and linux, so the group signal is always ESRCH.
  readonly pid = 2_147_483_000;
  killed = 0;
  onData() { return { dispose: () => {} }; }
  onExit() { return { dispose: () => {} }; }
  write() {}
  resize() {}
  kill() { this.killed += 1; }
}

describe('terminals stop on every archive / worktree-removal path', () => {
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, dry: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let worktree: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let ptys: FakePty[];

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-term-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-term-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-term-other-'));
    worktree = join(repoRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    ptys = [];
    const binding = async (): Promise<PtyBinding> => ({
      available: true,
      module: { spawn: () => { const pty = new FakePty(); ptys.push(pty); return pty; } },
    });
    sessions = new TerminalSessions(binding, undefined, () => null);
  });

  afterEach(async () => {
    sessions.dispose();
    store.flush();
    await removeTempDir(home, repoRoot, otherRoot);
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_DRY_RUN', saved.dry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      terminalSessions: sessions,
      ...over,
    });

  const seedRun = (target: RunStore, over: Record<string, unknown>) => {
    const run = target.createRun({ title: 't', workflow: 'quick-task', task: 'do a thing', steps: [] });
    target.updateRun(run.id, over as never);
    return run.id;
  };

  const open = async (app: ReturnType<typeof makeApp>, path: string) => {
    const res = await apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; topic: string };
  };

  it('bulk "Archive finished" stops the terminals of every task it archives, and only those', async () => {
    const app = makeApp();
    const finished = seedRun(store, { worktreePath: worktree, status: 'done' });
    const inReview = seedRun(store, { worktreePath: worktree, status: 'review' });
    await open(app, `/api/v1/runs/${finished}/terminal`);
    await open(app, `/api/v1/runs/${inReview}/terminal`);

    const res = await apiRequest(app, '/api/v1/runs/archive-finished', { method: 'POST' });
    expect(await res.json()).toEqual({ archived: 1 });

    expect(sessions.listFor(finished)).toEqual([]);
    expect(ptys[0]!.killed).toBeGreaterThan(0);
    // `review` is a gate the sweep leaves alone — and so is its shell.
    expect(sessions.listFor(inReview)).toHaveLength(1);
    expect(ptys[1]!.killed).toBe(0);
  });

  it('"Remove worktree" stops the terminals running inside it', async () => {
    const app = makeApp();
    const runId = seedRun(store, { worktreePath: worktree, status: 'done' });
    await open(app, `/api/v1/runs/${runId}/terminal`);

    const res = await apiRequest(app, `/api/v1/runs/${runId}/remove-worktree`, { method: 'POST' });
    expect(await res.json()).toEqual({ removed: true });

    expect(sessions.listFor(runId)).toEqual([]);
    expect(ptys[0]!.killed).toBeGreaterThan(0);
  });

  it('removing a project stops its tasks’ terminals, and nobody else’s', async () => {
    const contexts = new ProjectContexts({ listProjects });
    const other = await registerProject(otherRoot);
    const app = makeApp({ contexts });
    await contexts.context(other.id);
    const otherWorktree = join(otherRoot, 'wt');
    mkdirSync(otherWorktree, { recursive: true });
    const theirs = seedRun(contexts.peek(other.id)!.store, { worktreePath: otherWorktree, status: 'done' });
    const ours = seedRun(store, { worktreePath: worktree, status: 'done' });
    await open(app, `/api/v1/p/${other.id}/runs/${theirs}/terminal`);
    await open(app, `/api/v1/runs/${ours}/terminal`);

    const res = await apiRequest(app, `/api/v1/projects/${other.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(sessions.listFor(theirs)).toEqual([]);
    expect(ptys[0]!.killed).toBeGreaterThan(0);
    expect(sessions.listFor(ours)).toHaveLength(1);
    contexts.disposeAll();
  });

  it('a closed session’s WS topic is unregistered, not left answering forever', async () => {
    const socketHub = createSocketHub();
    const app = makeApp({ socketHub });
    const runId = seedRun(store, { worktreePath: worktree });
    const session = await open(app, `/api/v1/runs/${runId}/terminal`);
    const probe = { snapshot: async () => ({}), start: () => () => {} };
    // The hub refuses a duplicate name, which is exactly how to see that the topic is live.
    expect(() => socketHub.registerTopic(session.topic, probe)).toThrow(/already registered/);

    await apiRequest(app, `/api/v1/runs/${runId}/terminal/${session.id}`, { method: 'DELETE' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(() => socketHub.registerTopic(session.topic, probe)).not.toThrow();
  });
});

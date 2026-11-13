import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
import type { PtyBinding, PtyProcess } from './pty-module.ts';
import { TerminalSessions, projectTerminalOwner } from './sessions.ts';

/** The project terminal (#1526): shells owned by a project, opened in its root, never a task's. */

class FakePty implements PtyProcess {
  // Above any real pid on darwin and linux, so the group signal is always ESRCH.
  readonly pid = 2_147_483_000;
  killed = 0;
  written: string[] = [];
  size: [number, number] | null = null;
  private emit: ((data: string) => void) | null = null;
  constructor(readonly cwd: string) {}
  onData(listener: (data: string) => void) { this.emit = listener; return { dispose: () => { this.emit = null; } }; }
  onExit() { return { dispose: () => {} }; }
  write(data: string) { this.written.push(data); this.emit?.(`echo:${data}`); }
  resize(cols: number, rows: number) { this.size = [cols, rows]; }
  kill() { this.killed += 1; }
}

describe('project terminal routes', () => {
  const saved = {
    home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, terminal: process.env.CEZ_TERMINAL, dry: process.env.CEZ_DRY_RUN,
  };
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let worktree: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let ptys: FakePty[];

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pterm-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pterm-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pterm-other-'));
    worktree = join(repoRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_TERMINAL;
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    ptys = [];
    const binding = async (): Promise<PtyBinding> => ({
      available: true,
      module: {
        spawn: (_file: string, _args: string[], options: { cwd: string }) => {
          const pty = new FakePty(options.cwd);
          ptys.push(pty);
          return pty;
        },
      },
    } as unknown as PtyBinding);
    sessions = new TerminalSessions(binding, undefined, () => null);
  });

  afterEach(async () => {
    sessions.dispose();
    store.flush();
    await removeTempDir(home, repoRoot, otherRoot);
    for (const [key, value] of [
      ['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_TERMINAL', saved.terminal], ['CEZ_DRY_RUN', saved.dry],
    ] as const) {
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

  const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown = {}) =>
    apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const open = async (app: ReturnType<typeof makeApp>, path: string) => {
    const res = await post(app, path);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; runId: string; cwd: string; topic: string };
  };

  it('opens a shell in the project root, owned by the project', async () => {
    const app = makeApp();
    const session = await open(app, '/api/v1/terminal');
    expect(session.cwd).toBe(repoRoot);
    expect(session.runId).toBe(projectTerminalOwner(repoRoot));
    expect(ptys[0]!.cwd).toBe(repoRoot);

    const state = (await (await apiRequest(app, '/api/v1/terminal')).json()) as { available: boolean; sessions: { id: string }[] };
    expect(state.available).toBe(true);
    expect(state.sessions.map((entry) => entry.id)).toEqual([session.id]);
  });

  it('the boot alias and the scoped spelling reach the same shells', async () => {
    const app = makeApp();
    const session = await open(app, '/api/v1/terminal');
    const scoped = (await (await apiRequest(app, '/api/v1/p/default/terminal')).json()) as { sessions: { id: string }[] };
    expect(scoped.sessions.map((entry) => entry.id)).toEqual([session.id]);
  });

  it('writes, resizes and reads back output by cursor', async () => {
    const app = makeApp();
    const session = await open(app, '/api/v1/terminal');
    const input = await post(app, `/api/v1/terminal/${session.id}/input`, { data: 'ls\r' });
    expect(await input.json()).toEqual({ delivered: true });
    expect(ptys[0]!.written).toEqual(['ls\r']);

    const resize = await post(app, `/api/v1/terminal/${session.id}/resize`, { cols: 120, rows: 40 });
    expect(await resize.json()).toEqual({ resized: true });
    expect(ptys[0]!.size).toEqual([120, 40]);

    const output = (await (await apiRequest(app, `/api/v1/terminal/${session.id}/output?cursor=0`)).json()) as {
      data: string;
      cursor: number;
    };
    expect(output.data).toBe('echo:ls\r');
    expect(output.cursor).toBe('echo:ls\r'.length);
  });

  it('never answers for a task’s shell, and a task route never answers for the project’s', async () => {
    const app = makeApp();
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'do a thing', steps: [] });
    store.updateRun(run.id, { worktreePath: worktree } as never);
    const task = await open(app, `/api/v1/runs/${run.id}/terminal`);
    const project = await open(app, '/api/v1/terminal');

    expect((await apiRequest(app, `/api/v1/terminal/${task.id}/output`)).status).toBe(404);
    expect((await post(app, `/api/v1/terminal/${task.id}/input`, { data: 'x' })).status).toBe(404);
    expect((await apiRequest(app, `/api/v1/terminal/${task.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await apiRequest(app, `/api/v1/runs/${run.id}/terminal/${project.id}/output`)).status).toBe(404);

    const state = (await (await apiRequest(app, '/api/v1/terminal')).json()) as { sessions: { id: string }[] };
    expect(state.sessions.map((entry) => entry.id)).toEqual([project.id]);
    expect(ptys[0]!.killed).toBe(0);
  });

  it('a task route never answers for a project shell addressed by its owner key', async () => {
    const app = makeApp();
    const project = await open(app, '/api/v1/terminal');
    const owner = encodeURIComponent(projectTerminalOwner(repoRoot));

    expect((await apiRequest(app, `/api/v1/runs/${owner}/terminal/${project.id}/output`)).status).toBe(404);
    expect((await post(app, `/api/v1/runs/${owner}/terminal/${project.id}/input`, { data: 'x' })).status).toBe(404);
    expect((await apiRequest(app, `/api/v1/runs/${owner}/terminal/${project.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(ptys[0]!.written).toEqual([]);
    expect(ptys[0]!.killed).toBe(0);
  });

  it('is refused where the terminal policy is off, except stopping a shell', async () => {
    const app = makeApp();
    const session = await open(app, '/api/v1/terminal');
    process.env.CEZ_TERMINAL = '0';

    const state = (await (await apiRequest(app, '/api/v1/terminal')).json()) as { available: boolean; reason: string };
    expect(state.available).toBe(false);
    expect(state.reason).toContain('CEZ_TERMINAL');
    expect((await post(app, '/api/v1/terminal')).status).toBe(409);
    expect((await apiRequest(app, `/api/v1/terminal/${session.id}/output`)).status).toBe(409);
    expect((await post(app, `/api/v1/terminal/${session.id}/input`, { data: 'x' })).status).toBe(409);
    expect((await post(app, `/api/v1/terminal/${session.id}/resize`, { cols: 10, rows: 10 })).status).toBe(409);

    const stop = await apiRequest(app, `/api/v1/terminal/${session.id}`, { method: 'DELETE' });
    expect(await stop.json()).toEqual({ stopped: true });
    expect(ptys[0]!.killed).toBeGreaterThan(0);
    expect(sessions.listFor(projectTerminalOwner(repoRoot))).toEqual([]);
  });

  it('suggests the project root’s own commands', async () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const app = makeApp();
    const body = (await (await apiRequest(app, '/api/v1/terminal/commands')).json()) as { commands: { command: string }[] };
    expect(body.commands.map((entry) => entry.command)).toContain('npm run dev');
  });

  it('removing a project stops its own terminals, and nobody else’s', async () => {
    const contexts = new ProjectContexts({ listProjects });
    const other = await registerProject(otherRoot);
    const app = makeApp({ contexts });
    const theirs = await open(app, `/api/v1/p/${other.id}/terminal`);
    const ours = await open(app, '/api/v1/terminal');
    expect(theirs.cwd).toBe(otherRoot);

    const res = await apiRequest(app, `/api/v1/projects/${other.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(sessions.listFor(projectTerminalOwner(otherRoot))).toEqual([]);
    expect(ptys[0]!.killed).toBeGreaterThan(0);
    expect(sessions.listFor(projectTerminalOwner(repoRoot)).map((entry) => entry.id)).toEqual([ours.id]);
    contexts.disposeAll();
  });
});

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { PtyBinding, PtyProcess, PtySpawnOptions } from './terminal/pty-module.ts';
import { TerminalSessions } from './terminal/sessions.ts';

/** The project terminal (`/api/v1/terminal`): a shell in the project root, owned by the project. */

class FakePty implements PtyProcess {
  readonly pid = 778;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = 0;
  private data?: (chunk: string) => void;
  onData(listener: (chunk: string) => void) { this.data = listener; return { dispose: () => {} }; }
  onExit() { return { dispose: () => {} }; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resized.push([cols, rows]); }
  kill() { this.killed += 1; }
  emit(chunk: string) { this.data?.(chunk); }
}

describe('the project terminal routes', () => {
  let repoRoot: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let ptys: FakePty[];
  let spawned: PtySpawnOptions[];
  const saved = { remote: process.env.CEZ_REMOTE, terminal: process.env.CEZ_TERMINAL, dry: process.env.CEZ_DRY_RUN };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-project-terminal-'));
    mkdirSync(repoRoot, { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_TERMINAL;
    process.env.CEZ_DRY_RUN = '1';
    ptys = [];
    spawned = [];
    sessions = new TerminalSessions(async (): Promise<PtyBinding> => ({
      available: true,
      module: {
        spawn: (_file: string, _args: string[], options: PtySpawnOptions) => {
          spawned.push(options);
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        },
      },
    }));
  });

  afterEach(() => {
    sessions.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_REMOTE', saved.remote], ['CEZ_TERMINAL', saved.terminal], ['CEZ_DRY_RUN', saved.dry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = () =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', terminalSessions: sessions });
  const json = { 'content-type': 'application/json' };

  const open = async () => {
    const res = await apiRequest(makeApp(), '/api/v1/terminal', { method: 'POST', headers: json, body: JSON.stringify({ cols: 90, rows: 20 }) });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; topic: string; cwd: string };
  };

  it('opens a shell in the project root and lists it', async () => {
    const session = await open();
    expect(session.cwd).toBe(repoRoot);
    expect(session.topic).toBe(`terminal:${session.id}`);
    const state = await (await apiRequest(makeApp(), '/api/v1/terminal')).json() as { available: boolean; sessions: Array<{ id: string }> };
    expect(state.available).toBe(true);
    expect(state.sessions.map((entry) => entry.id)).toEqual([session.id]);
  });

  it('serves the same surface under the project scope', async () => {
    const res = await apiRequest(makeApp(), '/api/v1/p/default/terminal', { method: 'POST', headers: json, body: '{}' });
    expect(res.status).toBe(201);
  });

  it('reads output by cursor, writes input and resizes', async () => {
    const session = await open();
    ptys[0]!.emit('hello');
    const out = await (await apiRequest(makeApp(), `/api/v1/terminal/${session.id}/output?cursor=0`)).json() as { data: string };
    expect(out.data).toContain('hello');
    const input = await apiRequest(makeApp(), `/api/v1/terminal/${session.id}/input`, { method: 'POST', headers: json, body: JSON.stringify({ data: 'ls\r' }) });
    expect(input.status).toBe(200);
    expect(ptys[0]!.written).toEqual(['ls\r']);
    const resize = await apiRequest(makeApp(), `/api/v1/terminal/${session.id}/resize`, { method: 'POST', headers: json, body: JSON.stringify({ cols: 100, rows: 30 }) });
    expect(resize.status).toBe(200);
    expect(ptys[0]!.resized.at(-1)).toEqual([100, 30]);
  });

  it('refuses on a hosted cockpit unless CEZ_TERMINAL=1, but still lets a shell be stopped', async () => {
    const session = await open();
    process.env.CEZ_REMOTE = '1';
    const state = await (await apiRequest(makeApp(), '/api/v1/terminal')).json() as { available: boolean; reason?: string };
    expect(state.available).toBe(false);
    expect(state.reason).toContain('CEZ_TERMINAL=1');
    expect((await apiRequest(makeApp(), '/api/v1/terminal', { method: 'POST', headers: json, body: '{}' })).status).toBe(409);
    expect((await apiRequest(makeApp(), `/api/v1/terminal/${session.id}/output`)).status).toBe(409);
    expect((await apiRequest(makeApp(), `/api/v1/terminal/${session.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(ptys[0]!.killed).toBeGreaterThan(0);
  });

  it("never lets the project's url reach a task's shell", async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'x', steps: [] });
    const wt = join(repoRoot, 'wt');
    mkdirSync(wt, { recursive: true });
    store.updateRun(run.id, { worktreePath: wt } as never);
    const taskRes = await apiRequest(makeApp(), `/api/v1/runs/${run.id}/terminal`, { method: 'POST', headers: json, body: '{}' });
    const task = (await taskRes.json()) as { id: string };
    for (const [path, init] of [
      [`/api/v1/terminal/${task.id}/output`, undefined],
      [`/api/v1/terminal/${task.id}/input`, { method: 'POST', headers: json, body: JSON.stringify({ data: 'x' }) }],
      [`/api/v1/terminal/${task.id}`, { method: 'DELETE' }],
    ] as const) {
      expect((await apiRequest(makeApp(), path, init as RequestInit | undefined)).status).toBe(404);
    }
    expect(ptys[0]!.written).toEqual([]);
    // …and the task's own list does not show project shells.
    await open();
    const list = await (await apiRequest(makeApp(), `/api/v1/runs/${run.id}/terminal`)).json() as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(1);
  });
});

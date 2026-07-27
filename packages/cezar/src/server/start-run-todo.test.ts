import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { TodoItem } from '../todos.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { RunRecord } from '../runs/store.js';
import type { WorkflowDef } from '../workflows/types.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';
import { connectedProviderAuth } from './provider-auth.testkit.js';

/**
 * `POST /api/runs` `todoId` (#374) — the audit trail across the composer detour.
 *
 * Since the cockpit's Inbox "▶ Run" prefills `/new` instead of POSTing
 * `/api/todos/:id/start` (never launch blind — #355), the entry's id travels
 * `/new?…&todo=t1` → `todoId` → here, and a started run must land on the entry's
 * `startedTaskId` exactly as that route would have written it. Otherwise the
 * entry never leaves the inbox and a second Run duplicates the task.
 *
 * The hard rule these tests exist for: the bookkeeping is BEST-EFFORT. The run
 * is already created by the time we touch todos.json, so nothing about an
 * unknown, stale or already-started id may turn into a failed start.
 */
describe('POST /api/runs todoId', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let started: number;

  const todosFile = () => join(dataDir, 'todos.json');
  const writeTodos = (items: TodoItem[]) => writeFileSync(todosFile(), JSON.stringify(items), 'utf8');
  const readTodosFile = (): TodoItem[] => JSON.parse(readFileSync(todosFile(), 'utf8')) as TodoItem[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todorun-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    started = 0;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started += 1;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
      startVariants: (_workflow: WorkflowDef, input: StartRunInput, variants: number): RunRecord[] =>
        Array.from({ length: variants }, (_, i) => {
          started += 1;
          return store.createRun({
            title: 't',
            workflow: '(planned)',
            task: input.task,
            steps: [],
            variant: String.fromCharCode(65 + i),
          });
        }),
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'do the follow-up', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('marks the inbox entry started with the new run — the entry then leaves the inbox', async () => {
    writeTodos([{ id: 't1', summary: 'Follow up on the flaky test' }]);

    const res = await post({ ...base, todoId: 't1' });
    expect(res.status).toBe(201);
    const run = (await res.json()) as RunRecord;

    // Exactly what POST /api/todos/:id/start writes — `visibleTodos()` hides it from here on.
    expect(readTodosFile()[0]?.startedTaskId).toBe(run.id);
    // …and the entry survives as the audit trail rather than being deleted.
    expect(readTodosFile()).toHaveLength(1);
  });

  it('an unknown todo id still starts the run (bookkeeping never costs the user a task)', async () => {
    writeTodos([{ id: 't1', summary: 'Follow up' }]);

    const res = await post({ ...base, todoId: 'gone-long-ago' });

    expect(res.status).toBe(201);
    expect(started).toBe(1);
    expect(readTodosFile()[0]?.startedTaskId).toBeUndefined();
  });

  it('a missing todos.json still starts the run', async () => {
    const res = await post({ ...base, todoId: 't1' });
    expect(res.status).toBe(201);
    expect(started).toBe(1);
  });

  it('an already-started entry keeps its first run — a duplicate launch never overwrites it', async () => {
    writeTodos([{ id: 't1', summary: 'Follow up', startedTaskId: 'run-first' }]);

    const res = await post({ ...base, todoId: 't1' });

    // The run the user asked for still starts — the 409 belongs to /api/todos/:id/start, which
    // is the route that has an inbox entry (not a task) as its subject.
    expect(res.status).toBe(201);
    expect(readTodosFile()[0]?.startedTaskId).toBe('run-first');
  });

  it('records the FIRST variant for a ×2 launch — the thread the composer lands on', async () => {
    // Variants need a git repo (each one runs in its own worktree) or the route 400s — and a
    // real one: `getRepoInfo` reads HEAD, which is unborn until the first commit.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeTodos([{ id: 't1', summary: 'Follow up' }]);

    const res = await post({ ...base, todoId: 't1', variants: 2 });
    expect(res.status).toBe(201);
    const { runs } = (await res.json()) as { runs: RunRecord[] };

    expect(runs).toHaveLength(2);
    expect(readTodosFile()[0]?.startedTaskId).toBe(runs[0]?.id);
  });

  it('leaves the inbox alone when no todoId is sent (every other launch)', async () => {
    writeTodos([{ id: 't1', summary: 'Follow up' }]);

    expect((await post(base)).status).toBe(201);
    expect(readTodosFile()[0]?.startedTaskId).toBeUndefined();
  });

  it('bounds the id like every other string on this route', async () => {
    const res = await post({ ...base, todoId: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('todoId');
    expect(started).toBe(0);
  });

  it('rejects a non-string todoId with a 400 (the body stays zod-parsed)', async () => {
    expect((await post({ ...base, todoId: 42 })).status).toBe(400);
    expect((await post({ ...base, todoId: '' })).status).toBe(400);
    expect(started).toBe(0);
  });
});

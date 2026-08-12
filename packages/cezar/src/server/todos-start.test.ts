import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import type { TodoItem } from '../todos.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/todos/:id/start` (spec 007, extended by #401 + #413): the "▶ Run" flow that turns
 * an inbox entry into a task. Two optional body knobs share the one request:
 *  - #401 runner/model — the Inbox card's pills pick which backend runs the follow-up; the
 *    parsed override reaches `startRun` verbatim, a bad runner is a 400, and — unlike `/continue`
 *    — an omitted field means "host default" (there is no prior backend to keep, this is a START).
 *  - #413 prompt — extra instructions (e.g. a template inserted in the composer) appended to the
 *    suggested/summary task text.
 * A request with no body at all (every client before the pills and the composer) must behave
 * exactly as before — the bodyless POST starts on the host's `defaultRunner` with no extra
 * instructions. 404/409 and the malformed-body 400 are pinned here too. Capturing stub, per the
 * continue-run/start-run pattern.
 */
describe('POST /api/v1/todos/:id/start', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
  };

  beforeEach(() => {
    // #471 (merged from main): the follow-up inbox is opt-in and this route 409s without the
    // capability. These assertions are about the #401/#413 body, so it is switched on explicitly
    // rather than inherited from whatever the dev box exports.
    process.env.CEZ_FOLLOWUPS = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todos-start-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
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
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const start = (id: string, body?: unknown) =>
    apiRequest(app, `/api/v1/todos/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  // ---- route guards ---------------------------------------------------------------------------

  it('404s an unknown id', async () => {
    writeTodos([]);
    const res = await start('nope');
    expect(res.status).toBe(404);
    expect(captured).toBeUndefined();
  });

  it('404s for an unknown todo before validating the body', async () => {
    writeTodos([]);
    // A bad runner would be a 400 on a real entry, but "not found" wins — the todo is checked
    // before the body is parsed, so a missing id never leaks body-validation errors.
    const res = await start('missing', { runner: 'gemini' });
    expect(res.status).toBe(404);
    expect(captured).toBeUndefined();
  });

  it('409s an already-started entry', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', startedTaskId: 'run-9' }]);
    const res = await start('t1');
    expect(res.status).toBe(409);
    expect(captured).toBeUndefined();
  });

  it('409s an already-started entry, override or not', async () => {
    writeTodos([
      { id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing', startedTaskId: 'run-9' },
    ]);
    const res = await start('todo-1', { runner: 'codex' });
    expect(res.status).toBe(409);
    expect(captured).toBeUndefined();
  });

  // ---- #413 prompt ----------------------------------------------------------------------------

  it('a request with no body at all keeps the pre-#413 task exactly (backward compat)', async () => {
    writeTodos([
      { id: 't1', summary: 'Ship it', suggestedPrompt: 'Ship the release notes', suggestedArgs: '--dry-run' },
    ]);
    const res = await start('t1');
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship the release notes\n\nArguments: --dry-run');
  });

  it('an extra prompt is appended after suggestedArgs, separated by a blank line', async () => {
    writeTodos([
      { id: 't1', summary: 'Ship it', suggestedPrompt: 'Ship the release notes', suggestedArgs: '--dry-run' },
    ]);
    const res = await start('t1', { prompt: 'Also update the changelog.' });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe(
      'Ship the release notes\n\nArguments: --dry-run\n\nAlso update the changelog.',
    );
  });

  it('an entry with neither suggestedPrompt nor suggestedArgs still takes the extra prompt', async () => {
    writeTodos([{ id: 't1', summary: 'Rerun the failed checks' }]);
    const res = await start('t1', { prompt: 'Focus on the flaky one.' });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Rerun the failed checks\n\nFocus on the flaky one.');
  });

  it('a whitespace-only prompt degrades to absent — not appended, not a 400', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: '   ' });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it');
  });

  it('an empty body object behaves exactly like no body', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', {});
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it');
  });

  it('accepts exactly 20k prompt characters', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: 'x'.repeat(20_000) });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe(`Ship it\n\n${'x'.repeat(20_000)}`);
  });

  it('rejects an over-cap prompt with a 400, and never starts a run', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: 'x'.repeat(20_001) });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
    // The entry must still be startable afterwards — a rejected body must not half-consume it.
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a malformed JSON body with a 400 — it must not pass as "no body"', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await apiRequest(app, '/api/v1/todos/t1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt": "unterminated',
    });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
    expect(store.listRuns()).toHaveLength(0);
  });

  it('a zero-length body is still the body-less case, not a 400', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await apiRequest(app, '/api/v1/todos/t1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it');
  });

  it('rejects a non-string prompt with a 400', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await start('t1', { prompt: 42 });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('the suggested skill still becomes the one-off workflow when the prompt is extended', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', suggestedSkill: 'nonexistent-skill' }]);
    const res = await start('t1', { prompt: 'Extra note.' });
    // No such skill on disk in this scratch repo → falls back to quick-task, same as before #413.
    expect(res.status).toBe(201);
    expect(captured?.task).toBe('Ship it\n\nExtra note.');
  });

  // ---- #401 runner/model override -------------------------------------------------------------

  it('plumbs a runner + model override through to startRun', async () => {
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const res = await start('todo-1', { runner: 'codex', model: 'gpt-5.1-codex' });
    expect(res.status).toBe(201);
    expect(captured?.runner).toBe('codex');
    expect(captured?.model).toBe('gpt-5.1-codex');
    // The follow-up's own prompt still drives the task — the override only picks the engine.
    expect(captured?.task).toBe('Do the thing');
  });

  it('a bodyless POST omits both — the host default runs it, exactly as before #401', async () => {
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const res = await start('todo-1');
    expect(res.status).toBe(201);
    expect(captured?.runner).toBeUndefined();
    expect(captured?.model).toBeUndefined();
  });

  it('an empty JSON body omits both too', async () => {
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const res = await start('todo-1', {});
    expect(res.status).toBe(201);
    expect(captured?.runner).toBeUndefined();
    expect(captured?.model).toBeUndefined();
  });

  it('accepts a model on its own (single-backend host sends no runner)', async () => {
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const res = await start('todo-1', { model: 'opus' });
    expect(res.status).toBe(201);
    expect(captured?.model).toBe('opus');
    expect(captured?.runner).toBeUndefined();
  });

  it('rejects a model override while locked but still permits choosing the runner', async () => {
    writeFileSync(
      join(repoRoot, '.ai', 'cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);

    expect((await start('todo-1', { runner: 'codex', model: 'gpt-5.6-codex' })).status).toBe(409);
    expect(captured).toBeUndefined();

    expect((await start('todo-1', { runner: 'codex' })).status).toBe(201);
    expect(captured?.runner).toBe('codex');
    expect(captured?.model).toBeUndefined();
  });

  it('rejects an unknown runner with a 400 and never starts a run', async () => {
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const res = await start('todo-1', { runner: 'gemini' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  // ---- #401 + #413 together (the merge) -------------------------------------------------------

  it('carries a runner/model override and an extra prompt on the same Run', async () => {
    writeTodos([{ id: 'todo-1', summary: 'Ship the thing', suggestedPrompt: 'Do the thing' }]);
    const res = await start('todo-1', {
      runner: 'codex',
      model: 'gpt-5.1-codex',
      prompt: 'And add a regression test.',
    });
    expect(res.status).toBe(201);
    expect(captured?.runner).toBe('codex');
    expect(captured?.model).toBe('gpt-5.1-codex');
    expect(captured?.task).toBe('Do the thing\n\nAnd add a regression test.');
  });
});

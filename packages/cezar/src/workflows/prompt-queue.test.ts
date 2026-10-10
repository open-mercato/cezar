import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROMPT_QUEUE_MAX } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The session's PROMPT QUEUE (spec `.ai/specs/2026-10-09-design-mode.md` §8): prompts lined up
 * behind a busy session are delivered one at a time, each as its own turn, only when the turn
 * before it has ended.
 *
 * The cases follow AGENTS.md § "Changing a mechanism that already works":
 *  - BOTH turn-end handlers are exercised — a run's first session (`runAgentStep`) and a
 *    continuation (`runContinuation`) — because a release wired into one of them ships half a
 *    feature and still looks tested;
 *  - every refusal that keeps another mechanism's guarantee is pinned (a question is not
 *    answered by a queued prompt; a monitoring park is not woken by one);
 *  - the queue has an exit in every state, a closed run included.
 *
 * Driven dry through `scripts/mock-claude.mjs`. `mock:pause` holds a turn ~2 s, which is the
 * window these cases queue into.
 */
describe('the session prompt queue', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-promptq-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(async () => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    // The agent process may still hold the folder for a moment after it is told to stop — on
    // Windows that is EPERM rather than a silent success. Retried, and never the reason a case
    // fails: what is under test finished before this line.
    try {
      rmSync(repoRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    } catch {
      /* a leftover temp folder is not a test failure */
    }
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status=${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  const userMessages = (id: string): string[] => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; text?: string })
      .filter((event) => event.type === 'user-message')
      .map((event) => String(event.text));
  };

  const trackStatuses = (): string[] => {
    const seen: string[] = [];
    store.on('run', (record: RunRecord) => {
      if (seen[seen.length - 1] !== record.status) seen.push(record.status);
    });
    return seen;
  };

  const queued = (id: string) => (store.getRun(id)?.promptQueue ?? []).map((m) => m.text);

  it('holds prompts while the agent works and delivers them one per turn, in order', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:pause the first job', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'running' && manager.enqueuePrompt(record.id, 'mock:pause second job').ok);
    const third = manager.enqueuePrompt(record.id, 'third job');

    // Held, not written into the session: the agent is mid-turn on the first job.
    expect(third).toMatchObject({ ok: true, delivered: false });
    expect(queued(record.id)).toEqual(['mock:pause second job', 'third job']);
    expect(userMessages(record.id)).not.toContain('mock:pause second job');

    // The first turn ends → exactly ONE prompt goes in; the other is still waiting behind it.
    await waitFor(record.id, () => userMessages(record.id).includes('mock:pause second job'));
    expect(queued(record.id)).toEqual(['third job']);
    expect(userMessages(record.id)).not.toContain('third job');

    // The second turn ends → the last one goes in, and only then does the run come to rest.
    const statuses = trackStatuses();
    await waitFor(record.id, (r) => r?.status === 'waiting' && r.promptQueue === undefined);
    expect(userMessages(record.id).filter((text) => text.includes('job'))).toEqual(['mock:pause second job', 'third job']);
    // Between the queued prompts the run never parked: a delivered prompt is the next turn.
    expect(statuses.filter((status) => status === 'waiting')).toHaveLength(1);
  }, 60_000);

  it('sends a prompt straight in when the session is already at rest', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');

    expect(manager.enqueuePrompt(record.id, 'and now this')).toEqual({ ok: true, delivered: true });
    expect(store.getRun(record.id)?.promptQueue).toBeUndefined();
    expect(store.getRun(record.id)?.status).toBe('running');
    expect(userMessages(record.id)).toContain('and now this');
  }, 60_000);

  it('releases from a CONTINUATION session too — the twin turn-end handler', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done first pass', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');

    expect(manager.continueRun(record.id, { text: 'mock:pause reopened' })).toEqual({ ok: true });
    await waitFor(record.id, (r) => r?.status === 'running' && manager.enqueuePrompt(record.id, 'queued behind the continuation').ok);
    expect(queued(record.id)).toEqual(['queued behind the continuation']);

    await waitFor(record.id, () => userMessages(record.id).includes('queued behind the continuation'));
    await waitFor(record.id, (r) => r?.status === 'waiting' && r.promptQueue === undefined);
    expect(store.getRun(record.id)?.currentStepId).toMatch(/^continue-/);
  }, 60_000);

  it('starts the next prompt instead of closing the session when the agent says it is done', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:pause mock:done the first goal', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'running' && manager.enqueuePrompt(record.id, 'the second goal').ok);

    // CEZ:DONE with a prompt still lined up: the session stays open and takes it.
    await waitFor(record.id, () => userMessages(record.id).includes('the second goal'));
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.promptQueue).toBeUndefined();
  }, 60_000);

  it('does not answer the agent\'s question with a queued prompt', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:pause mock:ask which one?', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'running' && manager.enqueuePrompt(record.id, 'unrelated follow-up').ok);

    // The turn ends on a question: the run parks for the USER, and the queue stays put.
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.askParked).toBe(true);
    expect(queued(record.id)).toEqual(['unrelated follow-up']);
    expect(userMessages(record.id)).not.toContain('unrelated follow-up');
    // And a prompt queued WHILE the question is open waits too, rather than going "straight in".
    expect(manager.enqueuePrompt(record.id, 'another one')).toMatchObject({ ok: true, delivered: false });

    // The user answers; the turn that follows ends at rest, and only then does the queue move.
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'the first one' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting' && r.promptQueue === undefined);
    expect(userMessages(record.id).slice(-3)).toEqual(['the first one', 'unrelated follow-up', 'another one']);
  }, 60_000);

  it('does not wake a monitoring park with a queued prompt', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:pause mock:monitoring keep watching', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'running' && manager.enqueuePrompt(record.id, 'when you are free').ok);

    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    expect(queued(record.id)).toEqual(['when you are free']);
    expect(userMessages(record.id)).not.toContain('when you are free');
  }, 60_000);

  it('refuses a closed run, and keeps an undelivered prompt removable after the session ends', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:slow a long job', worktree: false });
    currentId = record.id;
    let entry: { id: string } | undefined;
    await waitFor(record.id, (r) => {
      if (r?.status !== 'running') return false;
      const result = manager.enqueuePrompt(record.id, 'never delivered');
      if (result.ok && !result.delivered) entry = result.message;
      return result.ok;
    });

    manager.cancel(record.id);
    await waitFor(record.id, (r) => r?.status === 'cancelled');
    // Nothing reopens a session to drain a queue: the prompt is still there, undelivered…
    expect(queued(record.id)).toEqual(['never delivered']);
    expect(manager.enqueuePrompt(record.id, 'too late')).toEqual({ ok: false, error: 'session closed' });
    // …and it has an exit.
    expect(manager.removeQueuedPrompt(record.id, 'no-such-id')).toBe(false);
    expect(manager.removeQueuedPrompt(record.id, entry!.id)).toBe(true);
    expect(store.getRun(record.id)?.promptQueue).toBeUndefined();
  }, 60_000);

  it('caps the queue', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:slow a long job', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'running' && manager.enqueuePrompt(record.id, 'prompt 1').ok);
    for (let n = 2; n <= PROMPT_QUEUE_MAX; n++) expect(manager.enqueuePrompt(record.id, `prompt ${n}`).ok).toBe(true);
    expect(manager.enqueuePrompt(record.id, 'one too many')).toEqual({
      ok: false,
      error: `prompt queue is full — ${PROMPT_QUEUE_MAX} prompts at most`,
    });
    expect(queued(record.id)).toHaveLength(PROMPT_QUEUE_MAX);
  }, 60_000);
});

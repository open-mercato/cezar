import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * The run manager's half of the Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`),
 * driven dry through the mock CLI. `mock:ask` ends a turn with a `Library` card; the mock echoes a
 * follow-up's text into its reply, which is how a test puts a `CEZ:ASK-CLOSE` line in the agent's mouth.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SINGLE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

describe('task questions in the run manager (Questions inbox)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-qinbox-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
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
    await removeTempDir(repoRoot);
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const events = (id: string) => store.readEvents(id) as Array<Record<string, unknown>>;
  const asks = (id: string) => store.getRun(id)?.asks ?? [];
  const turnEnds = (id: string) => events(id).filter((e) => e.type === 'turn-end').length;
  /** A follow-up turn ran to its end and the run parked again. */
  const nextPark = async (id: string, before: number) =>
    waitFor(id, (r) => r?.status === 'waiting' && turnEnds(id) > before);

  const askAndPark = async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:ask which library?', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && (r.asks?.length ?? 0) === 1);
    return record.id;
  };

  it('records each CEZ:ASK on the run, keyed by its ask.requested id (step turn-end)', async () => {
    const id = await askAndPark();
    const requested = events(id).filter((e) => e.type === 'ask.requested');
    expect(asks(id)).toEqual([
      expect.objectContaining({ requestId: requested[0]!.requestId, questions: [expect.objectContaining({ header: 'Library' })] }),
    ]);
    expect(asks(id)[0]?.closed).toBeUndefined();
    expect(store.getRun(id)?.attentionRequest?.requestId).toBe(asks(id)[0]?.requestId);
  }, 40_000);

  it('a message sent from the card closes it as answered, with an ask.closed event', async () => {
    const id = await askAndPark();
    const requestId = asks(id)[0]!.requestId;
    const before = turnEnds(id);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'date-fns' }], { askRequestId: requestId })).toBe(true);
    expect(asks(id)[0]?.closed).toMatchObject({ reason: 'answered', answer: 'date-fns' });
    expect(events(id).filter((e) => e.type === 'ask.closed')).toEqual([
      expect.objectContaining({ requestId, reason: 'answered', answer: 'date-fns' }),
    ]);
    await nextPark(id, before);
    // The answered card is not flagged after the turn either.
    expect(asks(id)[0]?.stale).toBeUndefined();
  }, 40_000);

  it('a composer reply closes nothing: the card stays open, flagged replied-in-chat', async () => {
    const id = await askAndPark();
    const before = turnEnds(id);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'hmm, let me think' }])).toBe(true);
    expect(asks(id)[0]?.closed).toBeUndefined();
    expect(asks(id)[0]?.stale?.why).toBe('replied-in-chat');
    await nextPark(id, before);
    expect(asks(id)[0]?.closed).toBeUndefined();
    expect(asks(id)[0]?.stale?.why).toBe('replied-in-chat'); // the first reason is kept
    expect(events(id).some((e) => e.type === 'ask.closed')).toBe(false);
  }, 40_000);

  it('a re-ask whose headers cover the open card replaces it', async () => {
    const id = await askAndPark();
    const first = asks(id)[0]!.requestId;
    const before = turnEnds(id);
    manager.sendMessage(id, [{ type: 'text', text: 'mock:ask once more' }]);
    await waitFor(id, (r) => (r?.asks?.length ?? 0) === 2 && turnEnds(id) > before);
    const [old, fresh] = asks(id);
    expect(old).toMatchObject({ requestId: first, closed: { reason: 'replaced', replacedBy: fresh!.requestId } });
    expect(fresh?.closed).toBeUndefined();
    expect(events(id).filter((e) => e.type === 'ask.closed')).toEqual([
      expect.objectContaining({ requestId: first, reason: 'replaced', replacedBy: fresh!.requestId }),
    ]);
  }, 40_000);

  it('CEZ:ASK-CLOSE withdraws the card by header and never reaches the transcript', async () => {
    const id = await askAndPark();
    const before = turnEnds(id);
    manager.sendMessage(id, [{ type: 'text', text: 'ok\nCEZ:ASK-CLOSE Library picked one myself\n' }]);
    await nextPark(id, before);
    expect(asks(id)[0]?.closed).toMatchObject({ reason: 'retracted', detail: 'picked one myself' });
    const texts = events(id).filter((e) => e.type === 'text').map((e) => String(e.text));
    expect(texts.some((text) => text.includes('Follow-up'))).toBe(true);
    expect(texts.some((text) => text.includes('CEZ:ASK-CLOSE'))).toBe(false);
  }, 40_000);

  it('a run that finishes ends its open question', async () => {
    const id = await askAndPark();
    expect(manager.finish(id)).toBe(true);
    await waitFor(id, (r) => ['done', 'review'].includes(r?.status ?? ''));
    expect(asks(id)[0]?.closed?.reason).toBe('ended');
    expect(events(id).filter((e) => e.type === 'ask.closed')).toHaveLength(1);
  }, 40_000);

  it('the continuation turn-end records, flags and withdraws too', async () => {
    const id = await askAndPark();
    expect(manager.finish(id)).toBe(true);
    await waitFor(id, (r) => ['done', 'review'].includes(r?.status ?? ''));
    expect(manager.continueRun(id, { text: 'mock:ask choose again' })).toEqual({ ok: true });
    await waitFor(id, (r) => r?.status === 'waiting' && (r.asks?.length ?? 0) === 2);
    expect(asks(id)[1]?.closed).toBeUndefined();
    const before = turnEnds(id);
    manager.sendMessage(id, [{ type: 'text', text: 'ok\nCEZ:ASK-CLOSE Library\n' }]);
    await nextPark(id, before);
    expect(asks(id)[1]?.closed?.reason).toBe('retracted');
    const closes = events(id).filter((e) => e.type === 'ask.closed');
    expect(closes.map((e) => e.reason)).toEqual(['ended', 'retracted']);
  }, 60_000);

  it('dismissing the question a run is parked on tells the agent and wakes it for one turn', async () => {
    const id = await askAndPark();
    const before = turnEnds(id);
    expect(manager.dismissAsk(id, asks(id)[0]!.requestId)).toEqual({ ok: true, delivered: 'session' });
    expect(asks(id)[0]?.closed?.reason).toBe('dismissed');
    await nextPark(id, before);
    const reply = events(id).filter((e) => e.type === 'text').map((e) => String(e.text)).at(-1);
    expect(reply).toContain('The user skipped your question «Library»');
    // Not a user message in the transcript; a note says what happened.
    expect(events(id).some((e) => e.type === 'note' && String(e.message).includes('question skipped'))).toBe(true);
    expect(manager.dismissAsk(id, asks(id)[0]!.requestId)).toMatchObject({ ok: false, status: 409 });
    expect(manager.dismissAsk(id, 'nope')).toMatchObject({ ok: false, status: 404 });
  }, 40_000);

  it('a parked session that refuses the dismiss note keeps it for the next Continue', async () => {
    const id = await askAndPark();
    const blocked = vi.spyOn(manager.lifecycle, 'isBlocked').mockReturnValue(true);
    try {
      expect(manager.dismissAsk(id, asks(id)[0]!.requestId)).toEqual({ ok: true, delivered: 'next-continue' });
    } finally {
      blocked.mockRestore();
    }
    expect(asks(id)[0]?.closed?.reason).toBe('dismissed');
    expect(store.getRun(id)?.askNotes).toEqual([expect.stringContaining('The user skipped your question «Library»')]);
  }, 40_000);

  it('a buffered engine message (a child report) flags nothing; a buffered user message does', () => {
    const id = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateRun(id, { status: 'running' });
    store.recordTaskAsk(id, { requestId: 'r1', askedAt: new Date().toISOString(), questions: [{ header: 'Scope', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] });
    // The start-up window `deferMessage` buffers into.
    const starting = (manager as unknown as { starting: Set<string> }).starting;
    starting.add(id);
    try {
      expect(manager.deferMessage(id, [{ type: 'text', text: 'Child abc reported: done' }])).toBe(true);
      expect(asks(id)[0]?.stale).toBeUndefined();
      expect(manager.deferMessage(id, [{ type: 'text', text: 'my own note' }], { userReply: true })).toBe(true);
      expect(asks(id)[0]?.stale?.why).toBe('replied-in-chat');
    } finally {
      starting.delete(id);
    }
  });

  it('dismissing a question the run already moved past only closes it', async () => {
    const id = await askAndPark();
    const requestId = asks(id)[0]!.requestId;
    const before = turnEnds(id);
    manager.sendMessage(id, [{ type: 'text', text: 'carry on without it' }]);
    await nextPark(id, before);
    const count = turnEnds(id);
    expect(manager.dismissAsk(id, requestId)).toEqual({ ok: true, delivered: 'none' });
    await new Promise((r) => setTimeout(r, 300));
    expect(turnEnds(id)).toBe(count);
  }, 40_000);

  it('an idle-closed run keeps its question open; a dismiss waits for the next Continue, which also lists open questions', async () => {
    const id = await askAndPark();
    // What the inactivity timer does (`armIdleTimer`).
    const state = (manager as unknown as { active: Map<string, { idleClosed?: boolean; session?: { end(): void } }> }).active.get(id)!;
    state.idleClosed = true;
    state.session!.end();
    await waitFor(id, (r) => (r?.idleClosedAt !== undefined || r?.awaitingAnswerSince !== undefined) && !manager.isActive(id));
    expect(asks(id)[0]?.closed).toBeUndefined(); // #2286: Continue can still answer it

    // A second card, so the Continue has one open question to list after the dismiss.
    store.recordTaskAsk(id, { requestId: 'second', askedAt: new Date().toISOString(), cardId: 'deploy-target', questions: [{ header: 'Deploy', question: 'Where?', options: [{ label: 'a' }, { label: 'b' }] }] });
    expect(manager.dismissAsk(id, asks(id)[0]!.requestId)).toEqual({ ok: true, delivered: 'next-continue' });
    expect(manager.isActive(id)).toBe(false); // queued, not resumed
    expect(store.getRun(id)?.askNotes).toHaveLength(1);

    expect(manager.continueRun(id, { text: 'go on', reply: {} })).toEqual({ ok: true });
    await waitFor(id, (r) => r?.status === 'waiting' && turnEnds(id) >= 2 && !r.askNotes);
    const opening = events(id).filter((e) => e.type === 'text').map((e) => String(e.text)).find((text) => text.includes('Okay — looking into') && text.includes('skipped'));
    expect(opening).toContain('The user skipped your question «Library»');
    const prompt = events(id).filter((e) => e.type === 'user-message').map((e) => String(e.text));
    expect(prompt.at(-1)).toBe('go on'); // the transcript keeps the user's own words
    // The Continue was the user's own reply: the card still open is flagged, not closed.
    expect(asks(id).find((a) => a.requestId === 'second')?.stale?.why).toBe('replied-in-chat');
  }, 60_000);

  it('a Continue that answers the card closes it as answered', async () => {
    const id = await askAndPark();
    const state = (manager as unknown as { active: Map<string, { idleClosed?: boolean; session?: { end(): void } }> }).active.get(id)!;
    state.idleClosed = true;
    state.session!.end();
    await waitFor(id, (r) => (r?.idleClosedAt !== undefined || r?.awaitingAnswerSince !== undefined) && !manager.isActive(id));
    const requestId = asks(id)[0]!.requestId;
    expect(manager.continueRun(id, { text: 'Luxon', reply: { askRequestId: requestId } })).toEqual({ ok: true });
    expect(asks(id)[0]?.closed).toMatchObject({ reason: 'answered', answer: 'Luxon' });
  }, 60_000);

  it('a restarted manager reads the open questions back and answers them through Continue', async () => {
    const id = await askAndPark();
    const state = (manager as unknown as { active: Map<string, { idleClosed?: boolean; session?: { end(): void } }> }).active.get(id)!;
    state.idleClosed = true;
    state.session!.end();
    await waitFor(id, (r) => (r?.idleClosedAt !== undefined || r?.awaitingAnswerSince !== undefined) && !manager.isActive(id));
    store.flush();
    manager.dispose();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    const requestId = asks(id)[0]!.requestId;
    expect(asks(id)[0]?.closed).toBeUndefined();
    expect(manager.sendMessage(id, [{ type: 'text', text: 'Luxon' }], { askRequestId: requestId })).toBe(true);
    expect(asks(id)[0]?.closed).toMatchObject({ reason: 'answered', answer: 'Luxon' });
    await waitFor(id, (r) => r?.status === 'waiting' && turnEnds(id) >= 2);
  }, 60_000);
});

describe('turn-end flags (Questions inbox § May be out of date)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-qflag-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager.dispose();
    store.flush();
    await removeTempDir(repoRoot);
  });

  const review = (runId: string, text: string, compacted = false) =>
    (manager as unknown as { reviewTaskAsksAtTurnEnd: (runId: string, state: { cwd: string }, text: string, compacted: boolean) => void })
      .reviewTaskAsksAtTurnEnd(runId, { cwd: repoRoot }, text, compacted);
  // `git log --since` has one-second resolution: keep the commits around an ask a second apart.
  const tick = () => new Promise((r) => setTimeout(r, 1_100));
  const setup = async () => {
    await tick();
    const id = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.recordTaskAsk(id, { requestId: 'r1', askedAt: new Date().toISOString(), questions: [{ header: 'Scope', question: '?', options: [{ label: 'a' }, { label: 'b' }] }] });
    await tick();
    return id;
  };
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('another turn without an answer flags task-moved-on', async () => {
    const id = await setup();
    review(id, 'did other work');
    await until(() => store.getRun(id)?.asks?.[0]?.stale !== undefined);
    expect(store.getRun(id)?.asks?.[0]?.stale?.why).toBe('task-moved-on');
    expect(store.getRun(id)?.asks?.[0]?.closed).toBeUndefined();
  });

  it('a commit since the ask flags new-commits; autosaves do not count', async () => {
    const id = await setup();
    writeFileSync(join(repoRoot, 'b.txt'), 'two\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'cezar autosave (turn end)'], { cwd: repoRoot });
    review(id, 'turn');
    await until(() => store.getRun(id)?.asks?.[0]?.stale !== undefined);
    expect(store.getRun(id)?.asks?.[0]?.stale?.why).toBe('task-moved-on');

    const second = await setup();
    writeFileSync(join(repoRoot, 'c.txt'), 'three\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'feat: real work'], { cwd: repoRoot });
    review(second, 'turn');
    await until(() => store.getRun(second)?.asks?.[0]?.stale !== undefined);
    expect(store.getRun(second)?.asks?.[0]?.stale?.why).toBe('new-commits');
  });

  it('a compaction boundary is not a turn: nothing is flagged', async () => {
    const id = await setup();
    review(id, 'compacting', true);
    await new Promise((r) => setTimeout(r, 300));
    expect(store.getRun(id)?.asks?.[0]?.stale).toBeUndefined();
  });

  it('an unknown CEZ:ASK-CLOSE id closes nothing and does not throw', async () => {
    const id = await setup();
    expect(() => review(id, 'CEZ:ASK-CLOSE unknown-id', true)).not.toThrow();
    expect(store.getRun(id)?.asks?.[0]?.closed).toBeUndefined();
  });
});

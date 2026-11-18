import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TASK_ASKS_MAX, type TaskAskRecord } from '@open-mercato/cezar-contract';

import { RunStore, TASK_ASK_NOTES_MAX } from './store.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import { asksNamedBy, asksReplacedBy, openAsksBlock } from './task-asks.ts';

const q = (header: string) => ({ header, question: `${header}?`, options: [{ label: 'A' }, { label: 'B' }] });
const ask = (requestId: string, headers: string[], extra: Partial<TaskAskRecord> = {}): TaskAskRecord => ({
  requestId,
  askedAt: new Date().toISOString(),
  questions: headers.map(q),
  ...extra,
});

describe('task ask rules (Questions inbox spec § Close rules)', () => {
  it('replaces by the same card id, and never across different ids', () => {
    const asks = [ask('r1', ['Scope'], { cardId: 'plan' }), ask('r2', ['Scope'], { cardId: 'other' })];
    expect(asksReplacedBy(asks, ask('r3', ['Renamed'], { cardId: 'plan' })).map((a) => a.requestId)).toEqual(['r1']);
  });

  it('without ids, replaces a card whose headers are all covered; partial overlap stays open', () => {
    const asks = [ask('r1', ['Scope']), ask('r2', ['Scope', 'Deploy'])];
    expect(asksReplacedBy(asks, ask('r3', ['scope ', 'Tests'])).map((a) => a.requestId)).toEqual(['r1']);
  });

  it('skips asks that are already closed', () => {
    const asks = [ask('r1', ['Scope'], { closed: { reason: 'answered', at: new Date().toISOString() } })];
    expect(asksReplacedBy(asks, ask('r2', ['Scope']))).toEqual([]);
  });

  it('CEZ:ASK-CLOSE names a card by id, or by header (spaces dropped) when it has none', () => {
    const asks = [ask('r1', ['Scope'], { cardId: 'plan' }), ask('r2', ['Deploy target'])];
    expect(asksNamedBy(asks, { id: 'plan' }).map((a) => a.requestId)).toEqual(['r1']);
    expect(asksNamedBy(asks, { id: 'Scope' })).toEqual([]); // has an id: the header does not name it
    expect(asksNamedBy(asks, { id: 'deploytarget' }).map((a) => a.requestId)).toEqual(['r2']);
    expect(asksNamedBy(asks, { id: 'nope' })).toEqual([]);
  });

  it('lists open asks for the agent, with the stale reason and the close instruction', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const block = openAsksBlock(
      [
        ask('r1', ['Scope'], { cardId: 'plan', askedAt: '2026-11-18T11:00:00Z', stale: { why: 'new-commits', detail: 'the task committed since it asked', since: '2026-11-18T11:30:00Z' } }),
        ask('r2', ['Deploy'], { askedAt: '2026-11-18T11:55:00Z' }),
        ask('r3', ['Gone'], { closed: { reason: 'answered', at: '2026-11-18T11:58:00Z' } }),
      ],
      'r2',
      now,
    );
    expect(block).toContain('- id plan (asked 1h ago) — may be out of date: the task committed since it asked');
    expect(block).not.toContain('Deploy'); // the one being answered
    expect(block).not.toContain('Gone');
    expect(block).toContain('CEZ:ASK-CLOSE <id> <reason>');
    expect(openAsksBlock([ask('r1', ['Scope'], { closed: { reason: 'dismissed', at: '2026-11-18T11:58:00Z' } })])).toBeUndefined();
  });
});

describe('RunStore task asks', () => {
  let dir: string;
  let store: RunStore;
  let runId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-asks-'));
    store = RunStore.open(dir);
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateRun(runId, { status: 'waiting' });
  });

  afterEach(() => {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const closedEvents = () => store.readEvents(runId).filter((event) => event.type === 'ask.closed');
  const asks = () => store.getRun(runId)?.asks ?? [];

  it('a re-ask with the same id closes the older card as replaced, with an ask.closed event', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope'], { cardId: 'plan' }));
    const changes: unknown[] = [];
    store.on('asks', (change) => changes.push(change));
    const closed = store.recordTaskAsk(runId, ask('r2', ['Renamed'], { cardId: 'plan' }));
    expect(closed.map((a) => a.requestId)).toEqual(['r1']);
    expect(asks()[0]?.closed).toMatchObject({ reason: 'replaced', replacedBy: 'plan' });
    expect(asks()[1]?.closed).toBeUndefined();
    expect(closedEvents()).toEqual([expect.objectContaining({ requestId: 'r1', reason: 'replaced', replacedBy: 'plan' })]);
    expect(changes).toHaveLength(1);
  });

  it('a partial header overlap leaves the older card open, flagged partly re-asked', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope', 'Deploy']));
    store.recordTaskAsk(runId, ask('r2', ['Scope']));
    expect(asks().every((a) => a.closed === undefined)).toBe(true);
    expect(closedEvents()).toEqual([]);
    expect(asks()[0]?.stale).toMatchObject({ why: 'partly-reasked', detail: 'a newer question asked «Scope» again' });
    expect(asks()[1]?.stale).toBeUndefined();
  });

  it('a partial re-ask replaces a weaker flag already on the card', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope', 'Deploy']));
    store.flagTaskAsks(runId, () => true, { why: 'replied-in-chat', detail: 'you replied', since: new Date().toISOString() });
    store.recordTaskAsk(runId, ask('r2', ['Deploy']));
    expect(asks()[0]?.stale?.why).toBe('partly-reasked');
  });

  it('a full re-ask without ids closes the older card, and does not flag it', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope', 'Deploy']));
    store.recordTaskAsk(runId, ask('r2', ['deploy', 'Scope', 'Tests']));
    expect(asks()[0]).toMatchObject({ closed: { reason: 'replaced', replacedBy: 'r2' } });
    expect(asks()[0]?.stale).toBeUndefined();
  });

  it('keeps the newest TASK_ASKS_MAX asks', () => {
    for (let i = 0; i < TASK_ASKS_MAX + 3; i++) store.recordTaskAsk(runId, ask(`r${i}`, [`H${i}`]));
    expect(asks()).toHaveLength(TASK_ASKS_MAX);
    expect(asks()[0]?.requestId).toBe('r3');
  });

  it('the cap evicts closed asks before an open one, and closes an evicted open one with an event', () => {
    store.recordTaskAsk(runId, ask('open-old', ['Keep']));
    for (let i = 1; i < TASK_ASKS_MAX; i++) {
      store.recordTaskAsk(runId, ask(`c${i}`, [`H${i}`]));
      store.closeTaskAsks(runId, (a) => a.requestId === `c${i}`, { reason: 'answered', at: new Date().toISOString() });
    }
    store.recordTaskAsk(runId, ask('new', ['New']));
    expect(asks()).toHaveLength(TASK_ASKS_MAX);
    expect(asks().map((a) => a.requestId)).toContain('open-old');
    expect(asks().map((a) => a.requestId)).not.toContain('c1');

    // Every slot open: the oldest open ask goes, announced as closed.
    for (const a of asks()) if (a.closed) store.recordTaskAsk(runId, ask(`o-${a.requestId}`, [`O-${a.requestId}`]));
    expect(asks().filter((a) => a.closed)).toEqual([]);
    const changes: Array<{ closed: TaskAskRecord[] }> = [];
    store.on('asks', (change) => changes.push(change));
    store.recordTaskAsk(runId, ask('newest', ['Newest']));
    expect(asks().map((a) => a.requestId)).not.toContain('open-old');
    expect(closedEvents()).toContainEqual(expect.objectContaining({ requestId: 'open-old', reason: 'expired' }));
    expect(changes[0]?.closed.map((a) => a.requestId)).toEqual(['open-old']);
  });

  it('a long partly-reasked detail is bounded to the schema', () => {
    const long = Array.from({ length: 19 }, (_, i) => `Header number ${i} that is long`);
    store.recordTaskAsk(runId, ask('r1', [...long, 'Other']));
    store.recordTaskAsk(runId, ask('r2', long));
    expect(asks()[0]?.stale?.detail.length).toBeLessThanOrEqual(300);
    store.flush();
    expect(readRunIndexFromDisk(dir)[0]?.asks).toHaveLength(2);
  });

  it('a flag keeps its first reason, still open; a close drops the flag', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope']));
    const since = new Date().toISOString();
    store.flagTaskAsks(runId, () => true, { why: 'replied-in-chat', detail: 'x', since });
    store.flagTaskAsks(runId, () => true, { why: 'task-moved-on', detail: 'y', since });
    expect(asks()[0]?.stale?.why).toBe('replied-in-chat');
    expect(asks()[0]?.closed).toBeUndefined();
    store.closeTaskAsks(runId, () => true, { reason: 'retracted', at: since, detail: 'no longer needed' });
    expect(asks()[0]).toMatchObject({ closed: { reason: 'retracted', detail: 'no longer needed' } });
    expect(asks()[0]?.stale).toBeUndefined();
    // Closing again is a no-op: no second event.
    expect(store.closeTaskAsks(runId, () => true, { reason: 'dismissed', at: since })).toEqual([]);
    expect(closedEvents()).toHaveLength(1);
  });

  it.each([
    ['done', 'Task done'],
    ['review', 'Task ready for review'],
    ['cancelled', 'Task cancelled'],
  ] as const)('a run reaching %s ends its open asks', (status, detail) => {
    store.recordTaskAsk(runId, ask('r1', ['Scope']));
    store.updateRun(runId, { status });
    expect(asks()[0]?.closed).toMatchObject({ reason: 'ended', detail });
    expect(closedEvents()).toEqual([expect.objectContaining({ requestId: 'r1', reason: 'ended', detail })]);
  });

  it('archiving ends open asks', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope']));
    store.updateRun(runId, { status: 'failed' });
    store.setArchived(runId, true);
    expect(asks()[0]?.closed).toMatchObject({ reason: 'ended', detail: 'Task archived' });
  });

  it('a failed run keeps its asks open: idle-closed, awaiting answer and error (#2286)', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope']));
    const at = new Date().toISOString();
    store.updateRun(runId, { status: 'waiting', idleClosedAt: at });
    store.updateRun(runId, { status: 'failed', awaitingAnswerSince: at });
    store.updateRun(runId, { status: 'failed', error: 'boom' });
    expect(asks()[0]?.closed).toBeUndefined();
    expect(closedEvents()).toEqual([]);
  });

  it('dismiss notes queue for the next Continue, bounded, and are taken once', () => {
    for (let i = 0; i < TASK_ASK_NOTES_MAX + 2; i++) store.pushAskNote(runId, `note ${i}`);
    expect(store.takeAskNotes(runId)).toHaveLength(TASK_ASK_NOTES_MAX);
    expect(store.takeAskNotes(runId)).toEqual([]);
  });

  it('asks survive the index round trip, and a malformed entry costs only itself', () => {
    store.recordTaskAsk(runId, ask('r1', ['Scope'], { cardId: 'plan', about: [{ pr: 12 }] }));
    store.recordTaskAsk(runId, ask('r2', ['Deploy']));
    store.flush();
    const index = join(dir, 'runs.json');
    const raw = JSON.parse(readFileSync(index, 'utf8'));
    const runs = Array.isArray(raw) ? raw : raw.runs;
    runs[0].asks[1].stale = { why: 'partly-reasked', detail: 'x'.repeat(400), since: 'now' };
    writeFileSync(index, JSON.stringify(raw));
    const [reread] = readRunIndexFromDisk(dir);
    expect(reread?.asks).toHaveLength(1);
    expect(reread?.asks?.[0]).toMatchObject({ requestId: 'r1', cardId: 'plan', about: [{ pr: 12 }] });
  });
});

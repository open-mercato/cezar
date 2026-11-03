import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunEvent } from '@open-mercato/cezar-contract';
import {
  HistoryCursorError,
  __clearContextCacheForTests,
  canonicalSessionItems,
  deriveRunContextEvents,
  readEventsAfterLiveCursor,
  readRunHistoryPage,
  streamRunEvents,
} from './event-history.ts';

const dirs: string[] = [];

function fixture(events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-history-'));
  dirs.push(dir);
  const file = join(dir, 'run.ndjson');
  writeFileSync(
    file,
    events.map((event) => JSON.stringify({ ts: '2026-07-30T00:00:00.000Z', ...event })).join('\n') + '\n',
  );
  return file;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('canonicalSessionItems', () => {
  it('collapses v2 lifecycle snapshots and suppresses v1 tool twins in a mixed turn', () => {
    const events = [
      { seq: 1, ts: 'x', type: 'turn.started', turnId: 't1' },
      { seq: 2, ts: 'x', type: 'tool-call', id: 'tool-1', tool: 'Bash' },
      { seq: 3, ts: 'x', type: 'item.started', item: { kind: 'tool', id: 'tool-1' } },
      { seq: 4, ts: 'x', type: 'tool-result', toolCallId: 'tool-1' },
      { seq: 5, ts: 'x', type: 'item.completed', item: { kind: 'tool', id: 'tool-1' } },
      { seq: 6, ts: 'x', type: 'note', message: 'done' },
    ] satisfies RunEvent[];
    expect(canonicalSessionItems(events).map(({ key }) => key)).toEqual([
      'v2::tool-1',
      'standalone:6',
    ]);
  });

  it('suppresses exact and fragmented v1 text twins using the reducer evidence', () => {
    const events = [
      { seq: 1, ts: 'x', type: 'turn.started', turnId: 't1' },
      {
        seq: 2,
        ts: 'x',
        type: 'item.completed',
        item: { kind: 'message', id: 'message-1', role: 'assistant', text: 'hello world' },
      },
      { seq: 3, ts: 'x', type: 'text', text: 'hello ' },
      { seq: 4, ts: 'x', type: 'text', text: 'world' },
      { seq: 5, ts: 'x', type: 'text', text: 'v1-only fallback' },
    ] satisfies RunEvent[];

    expect(canonicalSessionItems(events).map(({ key }) => key)).toEqual([
      'v2::message-1',
      'v1-text:1:5',
    ]);
  });
});

describe('readRunHistoryPage', () => {
  it('returns exactly the newest 100 items and pages the older remainder', async () => {
    const events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>> = [
      { seq: 1, type: 'turn.started', turnId: 't1' },
    ];
    for (let seq = 2; seq <= 151; seq += 1) {
      events.push({
        seq,
        type: 'item.completed',
        item: { kind: 'message', id: `m-${seq}`, role: 'assistant', text: String(seq) },
      });
    }
    const file = fixture(events);
    const newest = await readRunHistoryPage(file);
    expect(newest.itemCount).toBe(100);
    expect(canonicalSessionItems(newest.events)).toHaveLength(100);
    expect(newest.events).toHaveLength(101);
    expect(newest.hasOlder).toBe(true);
    expect(newest.events.at(-1)?.seq).toBe(151);
    expect(newest.olderCursor).toBeTypeOf('string');

    const older = await readRunHistoryPage(file, newest.olderCursor);
    expect(older.itemCount).toBe(50);
    expect(canonicalSessionItems(older.events)).toHaveLength(50);
    expect(older.events).toHaveLength(51);
    expect(older.hasOlder).toBe(false);
    expect(older.events.at(-1)?.seq).toBe(51);
    expect(older.newerCursor).toBeTypeOf('string');
    expect(older.asOfSeq).toBe(151);

    const newer = await readRunHistoryPage(file, older.newerCursor);
    expect(newer.itemCount).toBe(100);
    expect(canonicalSessionItems(newer.events)).toHaveLength(100);
    expect(newer.events).toHaveLength(101);
    expect(newer.events.at(-1)?.seq).toBe(151);
    expect(newer.newerCursor).toBeUndefined();
  });

  it('walks both directions through a single turn larger than five pages', async () => {
    const events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>> = [
      { seq: 1, type: 'turn.started', turnId: 'large-turn' },
    ];
    for (let seq = 2; seq <= 651; seq += 1) {
      events.push({
        seq,
        type: 'item.completed',
        item: { kind: 'message', id: `m-${seq}`, role: 'assistant', text: String(seq) },
      });
    }
    const file = fixture(events);
    const newest = await readRunHistoryPage(file);
    const previous = await readRunHistoryPage(file, newest.olderCursor);
    const forward = await readRunHistoryPage(file, previous.newerCursor);
    expect(canonicalSessionItems(newest.events)).toHaveLength(100);
    expect(newest.events).toHaveLength(101);
    expect(previous).toMatchObject({ itemCount: 100, hasOlder: true });
    expect(canonicalSessionItems(previous.events)).toHaveLength(100);
    expect(previous.events).toHaveLength(101);
    expect(canonicalSessionItems(forward.events)).toHaveLength(100);
    expect(forward.events).toHaveLength(101);
    expect(forward.events.at(-1)?.seq).toBe(651);
  });

  it('preserves UTF-8 when a multibyte code point crosses a reverse-read chunk boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-history-utf8-'));
    dirs.push(dir);
    const file = join(dir, 'run.ndjson');
    const build = (padding: number) => {
      const text = `before 🧪${'x'.repeat(padding)}`;
      const content = [
        JSON.stringify({
          seq: 1,
          ts: '2026-07-30T00:00:00.000Z',
          type: 'item.completed',
          item: { kind: 'message', id: 'unicode', role: 'assistant', text },
        }),
        JSON.stringify({ seq: 2, ts: '2026-07-30T00:00:01.000Z', type: 'note', message: 'tail' }),
      ].join('\n') + '\n';
      return { content, text };
    };
    const base = build(0);
    const emojiOffset = Buffer.byteLength(base.content.slice(0, base.content.indexOf('🧪')));
    const padding = emojiOffset + 1 + 64 * 1024 - Buffer.byteLength(base.content);
    expect(padding).toBeGreaterThan(0);
    const { content, text } = build(padding);
    expect(Buffer.byteLength(content) - 64 * 1024).toBe(emojiOffset + 1);
    writeFileSync(file, content);

    const page = await readRunHistoryPage(file);
    const unicode = page.events.find(({ seq }) => seq === 1);
    expect((unicode?.item as { text?: string } | undefined)?.text).toBe(text);
  });

  it('degrades a missing transcript to an empty live page', async () => {
    const page = await readRunHistoryPage('/no/such/transcript.ndjson');
    expect(page).toMatchObject({ events: [], itemCount: 0, asOfSeq: 0, hasOlder: false });
    expect(page.liveCursor).toBeTypeOf('string');
  });

  it('rejects malformed cursors without touching a path from cursor data', async () => {
    await expect(readRunHistoryPage('/no/such/transcript.ndjson', 'not-json')).rejects.toMatchObject({
      name: 'HistoryCursorError',
      status: 400,
    });
  });

  it('reads only the bounded tail of a deterministic 50,000-item transcript', async () => {
    const events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>> = [];
    for (let index = 0; index < 50_000; index += 1) {
      const seq = index * 2 + 1;
      events.push({ seq, type: 'turn.started', turnId: `t-${index}` });
      events.push({
        seq: seq + 1,
        type: 'item.completed',
        item: { kind: 'message', id: `m-${index}`, role: 'assistant', text: `message ${index}` },
      });
    }
    const file = fixture(events);
    let measured: { fileSize: number; bytesRead: number; retainedEvents: number } | undefined;
    const result = await readRunHistoryPage(file, undefined, (value) => {
      measured = value;
    });
    expect(result.itemCount).toBe(100);
    expect(result.events.length).toBeLessThanOrEqual(202);
    expect(measured).toBeDefined();
    expect(measured!.fileSize).toBe(statSync(file).size);
    expect(measured!.bytesRead).toBeLessThan(measured!.fileSize / 10);
    expect(measured!.retainedEvents).toBeLessThan(1_000);
  });
});

describe('live cursor replay and compact context', () => {
  it('replays only persisted lines appended after the captured live cursor', async () => {
    const file = fixture([
      { seq: 1, type: 'turn.started', turnId: 't1' },
      { seq: 2, type: 'note', message: 'before' },
    ]);
    const page = await readRunHistoryPage(file);
    appendFileSync(file, JSON.stringify({ seq: 4, ts: 'x', type: 'note', message: 'after gap' }) + '\n');
    const replay = await readEventsAfterLiveCursor(file, page.liveCursor);
    expect(replay.boundarySeq).toBe(2);
    expect(replay.events.map(({ seq }) => seq)).toEqual([4]);
  });

  it('returns 409 when a valid live cursor points beyond a replaced transcript', async () => {
    const file = fixture([
      { seq: 1, type: 'note', message: 'long enough to capture an offset' },
    ]);
    const page = await readRunHistoryPage(file);
    writeFileSync(file, '');
    await expect(readEventsAfterLiveCursor(file, page.liveCursor)).rejects.toEqual(
      expect.objectContaining<Partial<HistoryCursorError>>({ status: 409 }),
    );
  });

  it('keeps the latest plan and selector-relevant task lifecycle in chronological order', async () => {
    const file = fixture([
      { seq: 1, type: 'plan.updated', entries: [{ content: 'old', status: 'pending' }] },
      { seq: 2, type: 'turn.started', turnId: 't1' },
      {
        seq: 3,
        type: 'item.started',
        item: { kind: 'tool', id: 'task-1', toolKind: 'task', status: 'running' },
      },
      { seq: 4, type: 'plan.updated', entries: [{ content: 'new', status: 'in_progress' }] },
      {
        seq: 5,
        type: 'item.updated',
        item: { kind: 'tool', id: 'child-1', parentItemId: 'task-1', status: 'running' },
      },
    ]);
    const context = await deriveRunContextEvents(file);
    expect(context.asOfSeq).toBe(5);
    expect(context.contextEvents.map(({ seq }) => seq)).toEqual([2, 3, 4, 5]);
  });

  it('keeps an active root and its newest child after thousands of later context events', async () => {
    const events: Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>> = [
      { seq: 1, type: 'turn.started', turnId: 't1' },
      {
        seq: 2,
        type: 'item.started',
        item: { kind: 'tool', id: 'task-1', toolKind: 'task', status: 'running' },
      },
    ];
    for (let index = 0; index < 2_100; index += 1) {
      events.push({
        seq: 3 + index,
        type: 'item.updated',
        item: {
          kind: 'tool',
          id: 'child-1',
          parentItemId: 'task-1',
          status: 'running',
          title: `activity ${index}`,
        },
      });
    }
    const context = await deriveRunContextEvents(fixture(events));
    expect(context.contextEvents.some(({ seq }) => seq === 2)).toBe(true);
    expect(context.contextEvents.at(-1)?.seq).toBe(2_102);
    expect(context.contextEvents.length).toBeLessThan(10);
  });

  // #1202 — a skill is not a sub-agent episode. `Skill` answered to `toolKind: 'task'` until
  // then, so invoking one opened a root episode with no children under it and no fan-out behind
  // it, and the retention walk anchored on it as if it were live work.
  it('does not retain a skill as a root agent episode, but still retains a real task', async () => {
    const events = [
      { seq: 1, type: 'turn.started', turnId: 't1' },
      {
        seq: 2,
        type: 'item.completed',
        item: { kind: 'tool', id: 'skill-1', toolKind: 'skill', status: 'completed', title: 'Skill: om-auto-create-pr' },
      },
      {
        seq: 3,
        type: 'item.started',
        item: { kind: 'tool', id: 'task-1', toolKind: 'task', status: 'running', title: 'Task: one' },
      },
    ] satisfies Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>>;
    const context = await deriveRunContextEvents(fixture(events));
    const itemEvents = context.contextEvents.filter(({ type }) => type.startsWith('item.'));
    expect(itemEvents.map(({ seq }) => seq)).toEqual([3]);
  });

  it('preserves the current plan and lets a settled earlier fan-out bound carry-over', async () => {
    const events = [
      { seq: 1, type: 'turn.started', turnId: 't1' },
      { seq: 2, type: 'plan.updated', entries: [{ content: 'old', status: 'pending' }] },
      {
        seq: 3,
        type: 'item.started',
        item: { kind: 'tool', id: 'task-1', toolKind: 'task', status: 'running', title: 'Task: one' },
      },
      { seq: 4, type: 'user-message', text: 'steer' },
      { seq: 5, type: 'turn.started', turnId: 't2' },
      {
        seq: 6,
        type: 'item.started',
        item: { kind: 'tool', id: 'task-2', toolKind: 'task', status: 'running', title: 'Task: two' },
      },
      {
        seq: 7,
        type: 'item.updated',
        item: { kind: 'tool', id: 'task-1', toolKind: 'task', status: 'completed', title: 'Task: one' },
      },
      {
        seq: 8,
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'child-2',
          parentItemId: 'task-2',
          status: 'completed',
          title: 'Read a file',
        },
      },
      { seq: 9, type: 'plan.updated', entries: [] },
    ] satisfies Array<Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>>;
    const context = await deriveRunContextEvents(fixture(events));
    const itemEvents = context.contextEvents.filter(({ type }) => type.startsWith('item.'));
    expect(itemEvents.map(({ seq }) => seq)).toEqual([6, 8]);
    expect(context.contextEvents.at(-1)).toMatchObject({ seq: 9, type: 'plan.updated', entries: [] });
  });
});

describe('deriveRunContextEvents — per-file fold cache', () => {
  beforeEach(() => {
    __clearContextCacheForTests();
  });

  afterEach(() => {
    __clearContextCacheForTests();
  });

  function line(event: Partial<RunEvent> & Pick<RunEvent, 'seq' | 'type'>): string {
    return `${JSON.stringify({ ts: '2026-07-30T00:00:00.000Z', ...event })}\n`;
  }

  /** Two task fan-outs per turn with children, a plan, and turn boundaries — enough to prune. */
  function transcript(turns: number): string[] {
    const lines: string[] = [];
    let seq = 0;
    const push = (event: Omit<Partial<RunEvent>, 'seq'> & Pick<RunEvent, 'type'>) =>
      lines.push(line({ seq: ++seq, ...event }));
    for (let turn = 0; turn < turns; turn += 1) {
      push({ type: 'turn.started', turnId: `t${turn}` });
      for (const root of ['a', 'b']) {
        const id = `task-${turn}-${root}`;
        push({ type: 'item.started', item: { kind: 'tool', id, toolKind: 'task', status: 'running' } });
        push({ type: 'item.updated', item: { kind: 'tool', id: `${id}-c`, parentItemId: id, status: 'running' } });
        if (turn % 3 !== 2) push({ type: 'item.completed', item: { kind: 'tool', id, toolKind: 'task', status: 'completed' } });
      }
      push({ type: 'plan.updated', entries: [{ content: `step ${turn}`, status: 'in_progress' }] });
      push({ type: 'turn.completed' });
    }
    return lines;
  }

  function freshCopy(file: string, body: string): string {
    const copy = `${file}.fresh-${dirs.length}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(copy, body);
    return copy;
  }

  it('reads nothing to reopen an unchanged transcript and only the appended bytes after growth', async () => {
    const lines = transcript(6);
    const file = fixture([]);
    writeFileSync(file, lines.slice(0, 20).join(''));
    const reads: number[] = [];
    const onRead = ({ bytesRead }: { bytesRead: number }) => reads.push(bytesRead);

    await deriveRunContextEvents(file, onRead);
    await deriveRunContextEvents(file, onRead);
    const appended = lines.slice(20).join('');
    appendFileSync(file, appended);
    const grown = await deriveRunContextEvents(file, onRead);

    const probe = 64;
    expect(reads).toEqual([
      Buffer.byteLength(lines.slice(0, 20).join('')) + probe,
      0,
      Buffer.byteLength(appended) + probe + probe,
    ]);
    expect(grown).toEqual(await deriveRunContextEvents(freshCopy(file, lines.join(''))));
  });

  it('matches a fresh derivation at every append point', async () => {
    const lines = transcript(4);
    const file = fixture([]);
    writeFileSync(file, '');
    for (let index = 0; index < lines.length; index += 1) {
      appendFileSync(file, lines[index]!);
      const incremental = await deriveRunContextEvents(file);
      expect(incremental).toEqual(await deriveRunContextEvents(freshCopy(file, lines.slice(0, index + 1).join(''))));
    }
  });

  it('folds a record that was still being written once its line completes', async () => {
    const lines = transcript(2);
    const last = lines.at(-1)!;
    const file = fixture([]);
    writeFileSync(file, lines.slice(0, -1).join('') + last.slice(0, 10));

    const partial = await deriveRunContextEvents(file);
    appendFileSync(file, last.slice(10));
    const complete = await deriveRunContextEvents(file);

    expect(partial.asOfSeq).toBe(lines.length - 1);
    expect(complete).toEqual(await deriveRunContextEvents(freshCopy(file, lines.join(''))));
  });

  it('re-derives from the start when the transcript was replaced rather than appended to', async () => {
    const file = fixture([]);
    const first = transcript(3);
    writeFileSync(file, first.join(''));
    await deriveRunContextEvents(file);

    const replacement = [line({ seq: 1, type: 'plan.updated', entries: [] }), ...transcript(5).slice(1)];
    writeFileSync(file, replacement.join(''));

    expect(await deriveRunContextEvents(file)).toEqual(
      await deriveRunContextEvents(freshCopy(file, replacement.join(''))),
    );
  });

  it('keeps concurrent reads of one growing file consistent', async () => {
    const lines = transcript(5);
    const file = fixture([]);
    writeFileSync(file, lines.slice(0, 8).join(''));
    await deriveRunContextEvents(file);
    appendFileSync(file, lines.slice(8).join(''));

    const [left, right] = await Promise.all([deriveRunContextEvents(file), deriveRunContextEvents(file)]);
    const expected = await deriveRunContextEvents(freshCopy(file, lines.join('')));
    expect(left).toEqual(expected);
    expect(right).toEqual(expected);
  });

  it('hands every caller its own context, so one caller cannot edit what the next one reads', async () => {
    const file = fixture([]);
    writeFileSync(file, transcript(3).join(''));
    const first = await deriveRunContextEvents(file);
    const expected = structuredClone(first);
    first.contextEvents.length = 0;

    const second = await deriveRunContextEvents(file);
    expect(second).toEqual(expected);
    second.contextEvents.reverse();
    expect(await deriveRunContextEvents(file)).toEqual(expected);
  });

  it('degrades a transcript deleted after it was cached to an empty context', async () => {
    const file = fixture([]);
    writeFileSync(file, transcript(2).join(''));
    await deriveRunContextEvents(file);
    rmSync(file);

    expect(await deriveRunContextEvents(file)).toEqual({ contextEvents: [], asOfSeq: 0 });
  });

  it('bounds a run with no task fan-out to its current turn', async () => {
    const lines: string[] = [];
    let seq = 0;
    const push = (event: Omit<Partial<RunEvent>, 'seq'> & Pick<RunEvent, 'type'>) =>
      lines.push(line({ seq: ++seq, ...event }));
    for (let turn = 0; turn < 50; turn += 1) {
      push({ type: 'turn.started', turnId: `t${turn}` });
      push({ type: 'item.completed', item: { kind: 'message', id: `m${turn}`, role: 'assistant', text: String(turn) } });
      push({ type: 'turn.completed' });
    }
    const file = fixture([]);
    writeFileSync(file, lines.join(''));

    const context = await deriveRunContextEvents(file);

    expect(context.contextEvents.length).toBeLessThanOrEqual(2);
    expect(context.contextEvents.some(({ seq: eventSeq }) => eventSeq === 1)).toBe(false);
    expect(context.contextEvents.at(-1)?.seq).toBe(150);
    expect(context).toEqual(await deriveRunContextEvents(freshCopy(file, lines.join(''))));
  });

  it('keeps the cache at its LRU bound and re-reads a transcript it evicted', async () => {
    const files: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const file = fixture([]);
      writeFileSync(file, transcript(2).join(''));
      files.push(file);
    }
    for (const file of files) await deriveRunContextEvents(file);

    const reads: number[] = [];
    await deriveRunContextEvents(files[0]!, ({ bytesRead }) => reads.push(bytesRead));
    await deriveRunContextEvents(files[32]!, ({ bytesRead }) => reads.push(bytesRead));

    expect(reads[0]).toBeGreaterThan(0);
    expect(reads[1]).toBe(0);
  });
});

describe('streamRunEvents', () => {
  it('yields every parseable line in file order and skips malformed ones', async () => {
    const file = fixture([
      { seq: 1, type: 'note', message: 'one' },
      { seq: 2, type: 'note', message: 'two' },
    ]);
    appendFileSync(file, 'not json\n{"seq":3,"type":"note","ts":"x"}');
    const seqs: number[] = [];
    for await (const event of streamRunEvents(file)) seqs.push(event.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('yields nothing for a missing transcript', async () => {
    const seqs: number[] = [];
    for await (const event of streamRunEvents(join(tmpdir(), 'cez-missing-transcript.ndjson'))) seqs.push(event.seq);
    expect(seqs).toEqual([]);
  });
});

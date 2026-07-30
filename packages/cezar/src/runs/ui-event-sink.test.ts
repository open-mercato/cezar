/**
 * R2 step 2.1 — the RunManager's protocol-v2 persistence policy, executable:
 *
 *  - coalescing: raw `item.delta`s merge per item/field and flush at the
 *    ~40 ms boundary (immediately on that item's snapshot and on turn end);
 *  - persistence: golden-fixture replay proves NDJSON gets snapshots only —
 *    never a raw delta — stamped seq/ts by the store, usage only on change;
 *  - equivalence: the state a live consumer holds (snapshots + coalesced
 *    deltas) equals the state replayed from the persisted snapshots.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UiEvent, UiItem, UiToolItem } from '../core/ui-events.ts';
import { createCodexUiState, mapCodexNotification } from '../core/codex-ui-mapper.ts';
import { RunStore } from './store.ts';
import { DELTA_FLUSH_MS, UiEventSink, isV2WireEventType } from './ui-event-sink.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The codex golden fixture — the only backend emitting `item.delta` with a
 *  final snapshot carrying the full concatenation (reused, not duplicated). */
function codexFixture(): UiEvent[] {
  return JSON.parse(
    readFileSync(join(HERE, '../core/__fixtures__/codex/command-lifecycle.expected.json'), 'utf8'),
  ) as UiEvent[];
}

type Wire = Record<string, unknown> & { type: string };

function recorder() {
  const persisted: Wire[] = [];
  const live: Wire[] = [];
  /** What one SSE subscriber sees, in emission order (persisted lines fan
   *  out live too — `appendEvent` emits on the same bus). */
  const wire: Wire[] = [];
  const sink = new UiEventSink({
    persist: (e) => {
      persisted.push(e as Wire);
      wire.push(e as Wire);
    },
    emitLive: (e) => {
      live.push(e as Wire);
      wire.push(e as Wire);
    },
  });
  return { sink, persisted, live, wire };
}

function delta(itemId: string, delta: string, field: 'text' | 'reasoning' | 'output' = 'text'): UiEvent {
  return { type: 'item.delta', itemId, field, delta };
}

function toolItem(overrides: Partial<UiToolItem> = {}): UiToolItem {
  return {
    kind: 'tool',
    id: 'tool_1',
    name: 'commandExecution',
    toolKind: 'execute',
    title: 'Ran npm test',
    status: 'running',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('delta coalescing (fake timers)', () => {
  it('merges N rapid deltas for one item into ONE flushed delta at the ~40ms boundary', () => {
    vi.useFakeTimers();
    const { sink, persisted, live } = recorder();
    for (const chunk of ['a', 'b', 'c', 'd', 'e']) sink.handle(delta('item_1', chunk));
    expect(live).toEqual([]); // nothing until the window closes
    vi.advanceTimersByTime(DELTA_FLUSH_MS);
    expect(live).toEqual([{ type: 'item.delta', itemId: 'item_1', field: 'text', delta: 'abcde' }]);
    expect(persisted).toEqual([]); // raw deltas NEVER persist
    vi.advanceTimersByTime(1000);
    expect(live).toHaveLength(1); // window closed — no re-flush
  });

  it('never merges deltas across items, and keeps fields of one item separate', () => {
    vi.useFakeTimers();
    const { sink, live } = recorder();
    sink.handle(delta('item_a', 'A1'));
    sink.handle(delta('item_b', 'B1'));
    sink.handle(delta('item_a', 'A2'));
    sink.handle(delta('item_a', 'out', 'output'));
    vi.advanceTimersByTime(DELTA_FLUSH_MS);
    expect(live).toEqual([
      { type: 'item.delta', itemId: 'item_a', field: 'text', delta: 'A1A2' },
      { type: 'item.delta', itemId: 'item_a', field: 'output', delta: 'out' },
      { type: 'item.delta', itemId: 'item_b', field: 'text', delta: 'B1' },
    ]);
  });

  it("item.completed forces that item's immediate flush, delta before snapshot", () => {
    vi.useFakeTimers();
    const { sink, wire, persisted } = recorder();
    sink.handle({ type: 'item.started', item: toolItem() });
    sink.handle(delta('tool_1', 'line 1\n', 'output'));
    sink.handle(delta('tool_1', 'line 2\n', 'output'));
    const done = toolItem({ status: 'completed', output: 'line 1\nline 2\n', exitCode: 0 });
    sink.handle({ type: 'item.completed', item: done });
    expect(wire).toEqual([
      { type: 'item.started', item: toolItem() },
      { type: 'item.delta', itemId: 'tool_1', field: 'output', delta: 'line 1\nline 2\n' },
      { type: 'item.completed', item: done },
    ]);
    vi.advanceTimersByTime(1000);
    expect(persisted.filter((e) => e.type === 'item.delta')).toEqual([]);
    expect(wire).toHaveLength(3); // the armed timer was cancelled
  });

  it('turn.completed flushes ALL open coalescers before the turn snapshot', () => {
    vi.useFakeTimers();
    const { sink, wire } = recorder();
    sink.handle(delta('item_a', 'aaa'));
    sink.handle(delta('item_b', 'bbb', 'reasoning'));
    sink.handle({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
    expect(wire).toEqual([
      { type: 'item.delta', itemId: 'item_a', field: 'text', delta: 'aaa' },
      { type: 'item.delta', itemId: 'item_b', field: 'reasoning', delta: 'bbb' },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
  });

  it('flushAll (the v1 turn-end backstop) drains every buffer and is idempotent', () => {
    vi.useFakeTimers();
    const { sink, live } = recorder();
    sink.handle(delta('item_a', 'x'));
    sink.flushAll();
    sink.flushAll();
    vi.advanceTimersByTime(1000);
    expect(live).toEqual([{ type: 'item.delta', itemId: 'item_a', field: 'text', delta: 'x' }]);
  });

  it('an oversized buffer flushes immediately instead of growing unboundedly', () => {
    vi.useFakeTimers();
    const { sink, live } = recorder();
    sink.handle(delta('item_a', 'x'.repeat(64_000)));
    expect(live).toHaveLength(1); // no timer wait
  });
});

describe('snapshot persistence policy', () => {
  it('item.updated with streamed-content-only growth stays off disk (live-only); a status flip persists', () => {
    const { sink, persisted, live } = recorder();
    sink.handle({ type: 'item.started', item: toolItem({ status: 'pending' }) });
    const grown = toolItem({ status: 'pending', output: 'partial…' });
    sink.handle({ type: 'item.updated', item: grown });
    expect(persisted.map((e) => e.type)).toEqual(['item.started']);
    expect(live).toEqual([{ type: 'item.updated', item: grown }]); // live wire still sees it
    sink.handle({ type: 'item.updated', item: toolItem({ status: 'running', output: 'partial…' }) });
    expect(persisted.map((e) => e.type)).toEqual(['item.started', 'item.updated']);
  });

  it('usage.updated persists only when the cumulative total (or cost) moved', () => {
    const { sink, persisted } = recorder();
    const usage = { input: 100, output: 50, total: 150 };
    sink.handle({ type: 'usage.updated', usage });
    sink.handle({ type: 'usage.updated', usage });
    expect(persisted).toHaveLength(1);
    sink.handle({ type: 'usage.updated', usage: { ...usage, output: 60, total: 160 } });
    expect(persisted).toHaveLength(2);
    sink.handle({ type: 'usage.updated', usage: { ...usage, output: 60, total: 160 }, costUsd: 0.01 });
    expect(persisted).toHaveLength(3); // same total, new cost — persisted
  });

  it('v2 image events are dropped (the v1 image pipeline owns screenshots)', () => {
    const { sink, persisted, live } = recorder();
    sink.handle({ type: 'image', itemId: 'tool_1', mediaType: 'image/png', data: 'aGk=' });
    expect(persisted).toEqual([]);
    expect(live).toEqual([]);
  });

  it('sessionEnded flushes buffers, persists session.ended once, and seals the sink', () => {
    vi.useFakeTimers();
    const { sink, persisted, live } = recorder();
    sink.handle(delta('item_a', 'tail'));
    sink.sessionEnded('end_turn');
    expect(live).toEqual([{ type: 'item.delta', itemId: 'item_a', field: 'text', delta: 'tail' }]);
    expect(persisted).toEqual([{ type: 'session.ended', reason: 'end_turn' }]);
    sink.sessionEnded('end_turn'); // second settle is a no-op
    sink.handle({ type: 'turn.started', turnId: 'turn_9' }); // after close: ignored
    expect(persisted).toHaveLength(1);
  });

  it('a failed session persists a fatal session.error alongside session.ended', () => {
    const { sink, persisted } = recorder();
    sink.sessionEnded('error', 'claude CLI exited with code 1');
    expect(persisted).toEqual([
      { type: 'session.error', message: 'claude CLI exited with code 1', fatal: true },
      { type: 'session.ended', reason: 'error', message: 'claude CLI exited with code 1' },
    ]);
  });

  it('output failures are swallowed — v2 persistence must never throw into the runner', () => {
    const sink = new UiEventSink({
      persist: () => {
        throw new Error('run was deleted');
      },
      emitLive: () => {
        throw new Error('bus is gone');
      },
    });
    expect(() => {
      sink.handle({ type: 'turn.started', turnId: 'turn_1' });
      sink.handle(delta('item_a', 'x'));
      sink.flushAll();
      sink.sessionEnded('end_turn');
    }).not.toThrow();
  });
});

describe('golden-fixture replay through a real RunStore', () => {
  it('NDJSON gets seq/ts-stamped snapshots in order and zero item.delta lines; deltas ride the bus only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-sink-'));
    try {
      const store = RunStore.open(dir);
      const run = store.createRun({
        title: 't',
        workflow: 'w',
        task: 't',
        steps: [{ id: 's1', name: 'S', kind: 'agent' }],
      });
      const busTypes: string[] = [];
      store.on('event', ({ event }) => busTypes.push(event.type));
      const sink = new UiEventSink({
        persist: (e) => store.appendEvent(run.id, { ...e, stepId: 's1' }),
        emitLive: (e) => store.emitEphemeral(run.id, { ...e, stepId: 's1' }),
      });
      for (const event of codexFixture()) sink.handle(event);
      sink.sessionEnded('end_turn');

      const lines = store.readEvents(run.id);
      expect(lines.map((l) => l.type)).toEqual([
        'session.started',
        'turn.started',
        'item.started',
        'item.completed',
        'item.started',
        'item.completed',
        'usage.updated',
        'turn.completed',
        'session.ended',
      ]);
      for (const [i, line] of lines.entries()) {
        expect(line.stepId).toBe('s1');
        expect(typeof line.ts).toBe('string');
        expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
        if (i > 0) expect(line.seq).toBeGreaterThan(lines[i - 1]!.seq);
      }
      // The coalesced deltas reached live subscribers (item.completed forces
      // the flush) — they exist on the bus, never in the file.
      expect(busTypes.filter((t) => t === 'item.delta').length).toBeGreaterThan(0);
      // v2 lines route to the `ui-event` SSE name, v1 lines to `run-event`.
      expect(lines.every((l) => isV2WireEventType(l.type))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live-vs-disk equivalence', () => {
  /** Disk replay: snapshots upsert by id — last snapshot wins. */
  function reduceSnapshots(events: Wire[]): Map<string, UiItem> {
    const items = new Map<string, UiItem>();
    for (const e of events) {
      if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') {
        const item = e.item as UiItem;
        items.set(item.id, item);
      }
    }
    return items;
  }

  /** Live consumer: snapshots upsert; deltas append to the streamed field. */
  function reduceLive(events: Wire[]): Map<string, UiItem> {
    const items = new Map<string, UiItem>();
    for (const e of events) {
      if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') {
        const item = e.item as UiItem;
        items.set(item.id, structuredClone(item));
      } else if (e.type === 'item.delta') {
        const item = items.get(e.itemId as string);
        if (!item) continue;
        if (e.field === 'output' && item.kind === 'tool') {
          item.output = (item.output ?? '') + (e.delta as string);
        } else if (e.field !== 'output' && item.kind !== 'tool') {
          item.text += e.delta as string;
        }
      }
    }
    return items;
  }

  it('a live consumer (snapshots + coalesced deltas) converges on the persisted-snapshot state', () => {
    const { sink, persisted, wire } = recorder();
    for (const event of codexFixture()) sink.handle(event);
    sink.sessionEnded('end_turn');

    const fromDisk = reduceSnapshots(persisted);
    const fromLive = reduceLive(wire);
    expect(fromLive).toEqual(fromDisk);

    // The streamed path really carried the content: the merged live delta
    // equals the fixture's raw-delta concatenation AND the final snapshot.
    const merged = wire.find((e) => e.type === 'item.delta' && e.itemId === 'item_cmd_1');
    expect(merged?.delta).toBe('> cezar@0.1.0 test\n> vitest run\nTest Files  4 passed (4)\n');
    const final = fromDisk.get('item_cmd_1') as UiToolItem;
    expect(final.output).toBe(merged?.delta);
    expect(final.status).toBe('completed');
  });
});

describe('isV2WireEventType (the SSE event-name router)', () => {
  it('routes dotted v2 types to ui-event and every v1 type to run-event', () => {
    for (const t of ['session.started', 'session.ended', 'session.error', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed', 'plan.updated', 'usage.updated', 'permission.requested']) {
      expect(isV2WireEventType(t), t).toBe(true);
    }
    for (const t of ['text', 'tool-call', 'tool-result', 'image', 'token-usage', 'cost', 'session', 'turn-end', 'note', 'done', 'error', 'lifecycle', 'step-start', 'step-end', 'check-output', 'user-message']) {
      expect(isV2WireEventType(t), t).toBe(false);
    }
  });
});

/**
 * #528 — the regression guard for the whole persistence path: reasoning text
 * that arrives ONLY as `item/reasoning/textDelta` must still be readable after
 * a reload, which replays the NDJSON from scratch with no ephemeral deltas.
 */
describe('reasoning text survives persist → replay (#528)', () => {
  const THREAD = 'th_1';
  const TURN = 'turn_1';

  /** Codex closes the reasoning item with the summary only — the streamed
   *  prose lives nowhere but the deltas, which are never written to disk. */
  const FRAMES: unknown[] = [
    { method: 'thread/started', params: { thread: { id: THREAD } } },
    { method: 'turn/started', params: { turn: { id: TURN, status: 'inProgress', items: [] } } },
    {
      method: 'item/started',
      params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1', summary: 'Tracing it' } },
    },
    { method: 'item/reasoning/textDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'item_rsn_1', delta: 'The session cookie ' } },
    { method: 'item/reasoning/textDelta', params: { threadId: THREAD, turnId: TURN, itemId: 'item_rsn_1', delta: 'is dropped on refresh.' } },
    {
      method: 'item/completed',
      params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_1', summary: 'Tracing it' } },
    },
  ];

  it('a reload-style replay of the persisted snapshots shows the full reasoning text', () => {
    const { sink, persisted, live } = recorder();
    let state = createCodexUiState();
    for (const frame of FRAMES) {
      const mapped = mapCodexNotification(frame, state);
      state = mapped.state;
      for (const event of mapped.events) sink.handle(event);
    }
    sink.flushAll();

    // Deltas stay live-only — the policy this fix must not change.
    expect(persisted.some((e) => e.type === 'item.delta')).toBe(false);
    expect(live.some((e) => e.type === 'item.delta')).toBe(true);

    // What a page reload reconstructs: snapshots only, last one wins.
    const replayed = new Map<string, UiItem>();
    for (const e of persisted) {
      if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') {
        const item = e.item as UiItem;
        replayed.set(item.id, item);
      }
    }
    const reasoning = replayed.get('item_rsn_1');
    expect(reasoning?.kind).toBe('reasoning');
    expect(reasoning?.kind !== 'tool' && reasoning?.text).toBe('The session cookie is dropped on refresh.');
  });
});

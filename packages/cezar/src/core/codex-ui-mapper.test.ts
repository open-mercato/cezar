/**
 * Golden tests for the codex app-server → v2 mapper: each fixture in
 * `__fixtures__/codex/` is a JSONL frame transcript (shapes from
 * `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §3); its
 * `.expected.json` is the EXACT `UiEvent` sequence the mapper must produce.
 * All are wire-faithful except `todo-list`, which pins the tolerance arm for
 * codex's non-app-server transports — see the note on GOLDEN_FIXTURES.
 * Plus edge cases (never-throw, status map, state carry-over, no fabricated
 * cost) and a live wiring test through the real runner against the bundled
 * mock app-server.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent, UiItem } from './ui-events.ts';
import { codexSessionStarted, createCodexUiState, mapCodexNotification } from './codex-ui-mapper.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'codex');

/** Replay a fixture exactly as the runner drives the mapper: every parsed
 *  JSONL frame is folded in order, unparseable lines are skipped. (The
 *  fixtures carry the `thread/started` notification the real server sends,
 *  so the runner's result-path `codexSessionStarted` call is a dedup no-op.) */
function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createCodexUiState();
  const events: UiEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // mirrors the runner: malformed lines are skipped
    }
    const mapped = mapCodexNotification(msg, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return events;
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

const GOLDEN_FIXTURES = [
  'text-turn',
  // Reasoning streamed as textDelta and closed with a summary-only
  // `item/completed` — the wire shape #528 was reported against.
  'reasoning-stream',
  // Current app-server v2 snapshot shape: summary/content are string arrays.
  'reasoning-snapshot-arrays',
  'command-lifecycle',
  'file-change-and-mcp',
  // NOT app-server wire truth: codex has no `todoList` item and no `item/updated`
  // method. It pins the mapper's tolerance arm for codex's other transports only.
  // `turn-plan-updated` is the real app-server plan channel.
  'todo-list',
  'turn-plan-updated',
  'turn-failed',
  'review-mode',
  // Codex 0.144.6 generated schema, plus the current upstream spelling.
  'collab-agent-tool-call',
  'collab-tool-call',
  'sub-agent-activity',
] as const;

describe('codex → v2 golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      // Round-trip through JSON so stray `undefined` properties fail loudly —
      // these events get persisted as NDJSON in step 2.1.
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(expectedEvents(fixture));
    });
  }
});

describe('mapCodexNotification edge cases', () => {
  const state = createCodexUiState();

  it('malformed frames produce no events and never throw', () => {
    const frames: unknown[] = [
      null,
      undefined,
      42,
      'turn/started',
      [],
      {},
      { method: 5 },
      { id: 1, result: { thread: { id: 'th_1' } } }, // response — attributed by the runner, not the mapper
      { id: 2, error: { code: -32600, message: 'bad' } },
      // server→client REQUEST (approval prompt) — reserved for permission.*
      { id: 3, method: 'item/commandExecution/requestApproval', params: { itemId: 'x' } },
      { method: 'thread/status/changed', params: { status: 'active' } }, // unknown method
      { method: 'item/started' }, // no params
      { method: 'item/started', params: { item: 'oops' } },
      { method: 'item/started', params: { item: {} } }, // no type
      { method: 'item/started', params: { item: { type: 'commandExecution' } } }, // no id
      { method: 'item/agentMessage/delta', params: { delta: 'x' } }, // no itemId
      { method: 'item/agentMessage/delta', params: { itemId: 'a', delta: '' } }, // empty delta
      { method: 'thread/tokenUsage/updated', params: {} }, // no tokenUsage.total
      { method: 'thread/started', params: {} }, // no thread id
      // A garbled plan frame must not wipe a good plan — no `plan` array at all,
      // or one that is not an array, maps to zero events (not an empty plan).
      { method: 'turn/plan/updated', params: {} },
      { method: 'turn/plan/updated', params: { plan: 'oops' } },
      { method: 'turn/plan/updated', params: { plan: null } },
    ];
    for (const frame of frames) {
      const mapped = mapCodexNotification(frame, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('maps wire item statuses per the §7.1 table (no regex-on-status)', () => {
    const cases: Array<[string | undefined, string, string]> = [
      // [wire status, lifecycle phase, expected v2 status]
      ['inProgress', 'item/started', 'running'],
      ['inProgress', 'item/updated', 'running'],
      ['completed', 'item/completed', 'completed'],
      ['failed', 'item/completed', 'failed'],
      ['declined', 'item/completed', 'declined'],
      // no/unknown wire status → derived from the lifecycle phase
      [undefined, 'item/started', 'running'],
      [undefined, 'item/updated', 'running'],
      [undefined, 'item/completed', 'completed'],
      ['somethingNew', 'item/started', 'running'],
      ['somethingNew', 'item/completed', 'completed'],
    ];
    for (const [status, method, expected] of cases) {
      const item: Record<string, unknown> = { type: 'commandExecution', id: 'item_s', command: 'ls' };
      if (status !== undefined) item.status = status;
      const [event] = mapCodexNotification({ method, params: { item } }, state).events;
      expect(event).toMatchObject({ item: { status: expected } });
    }
  });

  it('a status word containing "error" in command output never marks the tool failed', () => {
    // The v1 path guessed failure by regexing the serialized item; v2 must
    // trust the status field only.
    const [event] = mapCodexNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            id: 'item_e',
            command: 'npm test',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'error TS2304 mentioned in a passing grep\n',
          },
        },
      },
      state,
    ).events;
    expect(event).toMatchObject({ type: 'item.completed', item: { status: 'completed', exitCode: 0 } });
  });

  it('a delta before item/started synthesizes a minimal item.started to upsert into', () => {
    const text = mapCodexNotification(
      { method: 'item/agentMessage/delta', params: { itemId: 'item_a', delta: 'hi' } },
      state,
    );
    expect(text.events).toEqual([
      { type: 'item.started', item: { kind: 'message', id: 'item_a', role: 'assistant', text: '' } },
      { type: 'item.delta', itemId: 'item_a', field: 'text', delta: 'hi' },
    ]);
    // The synthesized start is minted once; the next delta rides alone.
    const next = mapCodexNotification(
      { method: 'item/agentMessage/delta', params: { itemId: 'item_a', delta: ' there' } },
      text.state,
    );
    expect(next.events).toEqual([{ type: 'item.delta', itemId: 'item_a', field: 'text', delta: ' there' }]);
    // …without mutating the previous state (explicit-state contract).
    expect(state.knownItems.has('item_a')).toBe(false);

    const reasoning = mapCodexNotification(
      { method: 'item/reasoning/textDelta', params: { itemId: 'item_r', delta: 'because' } },
      state,
    );
    expect(reasoning.events[0]).toEqual({
      type: 'item.started',
      item: { kind: 'reasoning', id: 'item_r', text: '' },
    });

    const output = mapCodexNotification(
      { method: 'item/commandExecution/outputDelta', params: { itemId: 'item_c', delta: '$ ls\n' } },
      state,
    );
    expect(output.events).toEqual([
      {
        type: 'item.started',
        item: { kind: 'tool', id: 'item_c', name: 'commandExecution', toolKind: 'execute', title: 'Ran', status: 'running' },
      },
      { type: 'item.delta', itemId: 'item_c', field: 'output', delta: '$ ls\n' },
    ]);
  });

  it('accumulated outputDelta text becomes the final snapshot output when the wire item has none', () => {
    let s = createCodexUiState();
    for (const delta of ['line 1\n', 'line 2\n']) {
      s = mapCodexNotification(
        { method: 'item/commandExecution/outputDelta', params: { itemId: 'item_c1', delta } },
        s,
      ).state;
    }
    const done = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_c1', command: 'ls', status: 'completed', exitCode: 0 } } },
      s,
    );
    expect(done.events[0]).toMatchObject({ item: { output: 'line 1\nline 2\n', exitCode: 0 } });
    // Bookkeeping is dropped once the item completes.
    expect(done.state.outputs.has('item_c1')).toBe(false);
    expect(done.state.knownItems.has('item_c1')).toBe(false);

    // A wire-carried output always wins over the accumulator.
    const wireWins = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_c1', command: 'ls', status: 'completed', aggregatedOutput: 'authoritative' } } },
      s,
    );
    expect(wireWins.events[0]).toMatchObject({ item: { output: 'authoritative' } });
  });

  it('item/completed for an item that never started still completes a full snapshot', () => {
    const mapped = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_ghost', command: 'pwd', status: 'completed', exitCode: 0 } } },
      state,
    );
    expect(mapped.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'item_ghost',
          name: 'commandExecution',
          toolKind: 'execute',
          title: 'Ran pwd',
          status: 'completed',
          input: { command: 'pwd' },
          exitCode: 0,
        },
      },
    ]);
  });

  it('maps turn frames onto stop reasons per §7.1', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } }, 'end_turn'],
      [{ method: 'turn/completed', params: { turn: { id: 't1', status: 'interrupted' } } }, 'cancelled'],
      [{ method: 'turn/failed', params: { turn: { id: 't1', status: 'failed' }, error: { message: 'boom' } } }, 'error'],
      [{ method: 'turn/failed', params: { turn: { id: 't1', status: 'failed' }, error: { message: 'Turn interrupted' } } }, 'cancelled'],
      [{ method: 'turn/failed', params: { turn: { id: 't1', status: 'interrupted' } } }, 'cancelled'],
      [{ method: 'turn/failed', params: { turn: { id: 't1' } } }, 'error'],
    ];
    for (const [frame, stopReason] of cases) {
      const [event] = mapCodexNotification(frame, state).events;
      expect(event).toEqual({ type: 'turn.completed', turnId: 't1', stopReason });
    }
  });

  it('mints deterministic fallback turn ids when frames carry none', () => {
    let s = createCodexUiState();
    const started = mapCodexNotification({ method: 'turn/started', params: {} }, s);
    expect(started.events).toEqual([{ type: 'turn.started', turnId: 'turn_1' }]);
    s = started.state;
    // The close pairs with the open it tracked.
    const done = mapCodexNotification({ method: 'turn/completed', params: {} }, s);
    expect(done.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
  });

  it('never fabricates a cost: codex usage and turn events carry no costUsd', () => {
    const [usage] = mapCodexNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total: { totalTokens: 10, inputTokens: 6, outputTokens: 4 }, last: {} } },
      },
      state,
    ).events;
    expect(usage).toEqual({ type: 'usage.updated', usage: { input: 6, output: 4, total: 10 } });
    expect(usage && 'costUsd' in usage).toBe(false);

    const [turn] = mapCodexNotification(
      { method: 'turn/completed', params: { turn: { id: 't9', status: 'completed' } } },
      state,
    ).events;
    expect(turn && 'costUsd' in turn).toBe(false);
    expect(turn && 'usage' in turn).toBe(false);
  });

  it('sums the parts when the wire total is missing', () => {
    const [event] = mapCodexNotification(
      { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 7, outputTokens: 2 } } } },
      state,
    ).events;
    expect(event).toEqual({ type: 'usage.updated', usage: { input: 7, output: 2, total: 9 } });
  });

  it('attaches only a fresh in-turn tokenUsage.last snapshot to one completion', () => {
    let s = createCodexUiState();
    s = mapCodexNotification(
      { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 90, outputTokens: 10 }, last: { inputTokens: 90, outputTokens: 10 } } } },
      s,
    ).state;
    s = mapCodexNotification({ method: 'turn/started', params: { turn: { id: 't1' } } }, s).state;
    const noFreshUsage = mapCodexNotification({ method: 'turn/completed', params: { turn: { id: 't1' } } }, s);
    expect(noFreshUsage.events).toEqual([{ type: 'turn.completed', turnId: 't1', stopReason: 'end_turn' }]);

    s = mapCodexNotification({ method: 'turn/started', params: { turn: { id: 't2' } } }, noFreshUsage.state).state;
    s = mapCodexNotification(
      { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 200, outputTokens: 30 }, last: { inputTokens: 7, outputTokens: 3 } } } },
      s,
    ).state;
    const completed = mapCodexNotification({ method: 'turn/completed', params: { turn: { id: 't2' } } }, s);
    expect(completed.events).toEqual([
      { type: 'turn.completed', turnId: 't2', stopReason: 'end_turn', usage: { input: 7, output: 3, total: 10 } },
    ]);
    expect(mapCodexNotification({ method: 'turn/completed', params: { turn: { id: 't2' } } }, completed.state).events).toEqual([
      { type: 'turn.completed', turnId: 't2', stopReason: 'end_turn' },
    ]);
  });

  it('does not consume the active turn usage on a stale completion for an earlier turn', () => {
    let s = createCodexUiState();
    s = mapCodexNotification({ method: 'turn/started', params: { turn: { id: 't1' } } }, s).state;
    s = mapCodexNotification({ method: 'turn/completed', params: { turn: { id: 't1' } } }, s).state;
    s = mapCodexNotification({ method: 'turn/started', params: { turn: { id: 't2' } } }, s).state;
    s = mapCodexNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            total: { inputTokens: 100, outputTokens: 20 },
            last: { inputTokens: 8, outputTokens: 2 },
          },
        },
      },
      s,
    ).state;

    const stale = mapCodexNotification(
      { method: 'turn/completed', params: { turn: { id: 't1' } } },
      s,
    );
    expect(stale.events).toEqual([{ type: 'turn.completed', turnId: 't1', stopReason: 'end_turn' }]);
    expect(stale.state.currentTurnId).toBe('t2');

    expect(
      mapCodexNotification(
        { method: 'turn/completed', params: { turn: { id: 't2' } } },
        stale.state,
      ).events,
    ).toEqual([
      {
        type: 'turn.completed',
        turnId: 't2',
        stopReason: 'end_turn',
        usage: { input: 8, output: 2, total: 10 },
      },
    ]);
  });

  it('session.started is emitted once whichever path lands first', () => {
    let s = createCodexUiState();
    const viaNotification = mapCodexNotification(
      { method: 'thread/started', params: { thread: { id: 'th_1' } } },
      s,
    );
    expect(viaNotification.events).toEqual([{ type: 'session.started', sessionId: 'th_1', backend: 'codex' }]);
    // The runner's result-path call afterwards is a no-op…
    expect(codexSessionStarted('th_1', viaNotification.state).events).toEqual([]);
    // …and so is a duplicate notification after the result path.
    s = codexSessionStarted('th_2', createCodexUiState()).state;
    expect(mapCodexNotification({ method: 'thread/started', params: { thread: { id: 'th_2' } } }, s).events).toEqual([]);
  });

  it('todoList entries with malformed rows are filtered; a text-only plan item becomes one in-progress entry', () => {
    const [plan] = mapCodexNotification(
      {
        method: 'item/updated',
        params: {
          item: {
            type: 'todoList',
            id: 'item_t',
            items: [{ text: 'ok', completed: true }, { completed: false }, 'junk', { text: 'later', completed: false }],
          },
        },
      },
      state,
    ).events;
    expect(plan).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'ok', status: 'completed' },
        { content: 'later', status: 'pending' },
      ],
    });

    const [textPlan] = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Fix the redirect, then add tests' } } },
      state,
    ).events;
    expect(textPlan).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'Fix the redirect, then add tests', status: 'in_progress' }],
    });
  });

  it('review-mode and context-compaction items have human labels', () => {
    const [review] = mapCodexNotification(
      { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'item_rv' } } },
      state,
    ).events;
    expect(review).toEqual({
      type: 'item.started',
      item: { kind: 'tool', id: 'item_rv', name: 'enteredReviewMode', toolKind: 'task', title: 'Review', status: 'running' },
    });

    const [compaction] = mapCodexNotification(
      { method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'item_cc' } } },
      state,
    ).events;
    expect(compaction).toMatchObject({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'item_cc',
        name: 'contextCompaction',
        toolKind: 'other',
        title: 'Compacted context',
        status: 'completed',
      },
    });
  });

  it('labels imageView items with the inspected path', () => {
    const [imageView] = mapCodexNotification(
      {
        method: 'item/completed',
        params: { item: { type: 'imageView', id: 'item_image', path: '/tmp/checkout-preview.png' } },
      },
      state,
    ).events;
    expect(imageView).toEqual({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'item_image',
        name: 'imageView',
        toolKind: 'read',
        title: 'View image /tmp/checkout-preview.png',
        status: 'completed',
        input: { type: 'imageView', id: 'item_image', path: '/tmp/checkout-preview.png' },
      },
    });
  });

  // The pair is ONE span of work: mapped literally it would be two childless task
  // items, which the Agents dock reads as two sub-agents that each did nothing (#474).
  describe('review mode folds into one task item', () => {
    it('completes the ENTERED item when the exit frame arrives, not a second item', () => {
      const entered = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'item_rv_1' } } },
        state,
      );
      const exited = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'exitedReviewMode', id: 'item_rv_2', status: 'completed' } } },
        entered.state,
      );
      expect(exited.events).toEqual([
        {
          type: 'item.completed',
          item: { kind: 'tool', id: 'item_rv_1', name: 'enteredReviewMode', toolKind: 'task', title: 'Review', status: 'completed' },
        },
      ]);
      expect(exited.state.reviewItemId).toBeNull();
    });

    it('falls back to its own item for an unpaired exit (a stream that starts mid-review)', () => {
      const mapped = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'exitedReviewMode', id: 'item_rv_2', status: 'completed' } } },
        state,
      );
      expect(mapped.events).toEqual([
        {
          type: 'item.completed',
          item: { kind: 'tool', id: 'item_rv_2', name: 'exitedReviewMode', toolKind: 'task', title: 'Review', status: 'completed' },
        },
      ]);
    });

    it('closes the span when the entered frame itself arrives already completed', () => {
      const mapped = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'enteredReviewMode', id: 'item_rv_1', status: 'completed' } } },
        state,
      );
      expect(mapped.state.reviewItemId).toBeNull()
      // The next exit has nothing to pair with, so it maps under its own id.
      const exited = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'exitedReviewMode', id: 'item_rv_2' } } },
        mapped.state,
      );
      expect(exited.events[0]).toMatchObject({ type: 'item.completed', item: { id: 'item_rv_2' } });
    });

    // Without this, an interrupted review leaves a `running` task item forever — and the
    // Agents dock reads a FINISHED run as a live fan-out (`Agents · 0/1 — starting…`).
    it('closes an open span when the turn ends, so nothing is left running', () => {
      const entered = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'item_rv_1' } } },
        state,
      );
      const ended = mapCodexNotification(
        { method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } },
        entered.state,
      );
      expect(ended.events[0]).toEqual({
        type: 'item.completed',
        item: { kind: 'tool', id: 'item_rv_1', name: 'enteredReviewMode', toolKind: 'task', title: 'Review', status: 'completed' },
      });
      expect(ended.events[1]).toMatchObject({ type: 'turn.completed' });
      expect(ended.state.reviewItemId).toBeNull();
    });

    it('marks the span failed when the turn itself failed', () => {
      const entered = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'item_rv_1' } } },
        state,
      );
      const ended = mapCodexNotification(
        { method: 'turn/failed', params: { turn: { id: 'turn_1' }, error: { message: 'boom' } } },
        entered.state,
      );
      expect(ended.events[0]).toMatchObject({ type: 'item.completed', item: { id: 'item_rv_1', status: 'failed' } });
    });

    it('emits no review completion for a turn that had no open span', () => {
      const ended = mapCodexNotification(
        { method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } },
        state,
      );
      expect(ended.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
    });

    // The same displacement rule the opencode subtask slot would need: never leak a row.
    it('settles the previous span when a second entered frame displaces it', () => {
      const first = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'rv_1' } } },
        state,
      );
      const second = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'rv_2' } } },
        first.state,
      );
      expect(second.events).toEqual([
        {
          type: 'item.completed',
          item: { kind: 'tool', id: 'rv_1', name: 'enteredReviewMode', toolKind: 'task', title: 'Review', status: 'completed' },
        },
        {
          type: 'item.started',
          item: { kind: 'tool', id: 'rv_2', name: 'enteredReviewMode', toolKind: 'task', title: 'Review', status: 'running' },
        },
      ]);
      expect(second.state.reviewItemId).toBe('rv_2');
    });

    // The latch must follow the RESOLVED status, not the lifecycle phase the frame arrived in.
    it('keeps the span open for an item/completed frame that is still in progress', () => {
      const mapped = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'enteredReviewMode', id: 'rv_1', status: 'inProgress' } } },
        state,
      );
      expect(mapped.events[0]).toMatchObject({ item: { status: 'running' } });
      expect(mapped.state.reviewItemId).toBe('rv_1');
    });

    it('closes the span for an item/started frame that already carries a terminal status', () => {
      const mapped = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'rv_1', status: 'completed' } } },
        state,
      );
      expect(mapped.events[0]).toMatchObject({ item: { status: 'completed' } });
      expect(mapped.state.reviewItemId).toBeNull();
    });

    it('re-arms across consecutive review spans in one session', () => {
      let next = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'rv_a' } } },
        state,
      ).state;
      next = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'exitedReviewMode', id: 'rv_a_end' } } },
        next,
      ).state;
      const second = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'enteredReviewMode', id: 'rv_b' } } },
        next,
      );
      expect(second.state.reviewItemId).toBe('rv_b');
      expect(
        mapCodexNotification(
          { method: 'item/completed', params: { item: { type: 'exitedReviewMode', id: 'rv_b_end' } } },
          second.state,
        ).events[0],
      ).toMatchObject({ item: { id: 'rv_b' } });
    });
  });

  it("the user's own echoed message maps to zero events", () => {
    const mapped = mapCodexNotification(
      { method: 'item/started', params: { item: { type: 'userMessage', id: 'item_u', content: [{ type: 'text', text: 'hi' }] } } },
      state,
    );
    expect(mapped.events).toEqual([]);
  });

  // `turn/plan/updated` is the ONLY channel codex's `update_plan` reaches the
  // client on: the app-server v2 `ThreadItem` union has no todo variant, so a
  // plan that is not read off this notification never renders at all.
  describe('turn/plan/updated (the real update_plan channel)', () => {
    const planFrame = (plan: unknown) => ({
      method: 'turn/plan/updated',
      params: { threadId: 'th_1', turnId: 'turn_1', explanation: null, plan },
    });

    it('normalizes the wire status vocabulary, which is camelCase on app-server', () => {
      // `inProgress` is what the app-server layer re-serializes to, even though
      // codex's core protocol type spells it `in_progress` — accept both.
      const events = mapCodexNotification(
        planFrame([
          { step: 'a', status: 'pending' },
          { step: 'b', status: 'inProgress' },
          { step: 'c', status: 'in_progress' },
          { step: 'd', status: 'completed' },
        ]),
        state,
      ).events;
      expect(events).toEqual([
        {
          type: 'plan.updated',
          entries: [
            { content: 'a', status: 'pending' },
            { content: 'b', status: 'in_progress' },
            { content: 'c', status: 'in_progress' },
            { content: 'd', status: 'completed' },
          ],
        },
      ]);
    });

    it('treats an unknown or missing status as pending rather than dropping the step', () => {
      const events = mapCodexNotification(
        planFrame([{ step: 'a', status: 'sideways' }, { step: 'b' }]),
        state,
      ).events;
      expect(events).toEqual([
        { type: 'plan.updated', entries: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] },
      ]);
    });

    it('filters malformed steps but keeps the good ones', () => {
      const events = mapCodexNotification(
        planFrame(['oops', null, 42, { status: 'pending' }, { step: 5 }, { step: 'real', status: 'pending' }]),
        state,
      ).events;
      expect(events).toEqual([{ type: 'plan.updated', entries: [{ content: 'real', status: 'pending' }] }]);
    });

    it('emits an empty plan for an empty list — a cleared plan is a real snapshot', () => {
      expect(mapCodexNotification(planFrame([]), state).events).toEqual([{ type: 'plan.updated', entries: [] }]);
    });

    // "the agent cleared its plan" and "we could not parse the steps" both end up
    // as `[]` downstream, where the dock unmounts — so only the former may emit.
    it('a list whose every row is unreadable emits nothing rather than wiping the plan', () => {
      // e.g. a wire revision that renamed `step`, which would otherwise blank the dock.
      for (const plan of [[{ text: 'a' }, { text: 'b' }], ['junk'], [null], [{ step: 5 }], [{}]]) {
        expect(mapCodexNotification(planFrame(plan), state).events).toEqual([]);
      }
    });

    it('is full-replacement: the frame is the whole plan, with no entries accumulated', () => {
      // Contrast claude's id-keyed task map: nothing from the first frame may
      // survive into the second. The only state kept is the precedence latch.
      const first = mapCodexNotification(planFrame([{ step: 'a', status: 'completed' }]), state);
      const second = mapCodexNotification(planFrame([{ step: 'b', status: 'pending' }]), first.state);
      expect(second.events).toEqual([{ type: 'plan.updated', entries: [{ content: 'b', status: 'pending' }] }]);
      expect({ ...second.state, planFromNotification: false }).toEqual(state);

      // The latch settles after the first frame rather than churning state.
      const third = mapCodexNotification(planFrame([{ step: 'c', status: 'pending' }]), second.state);
      expect(third.state).toBe(second.state);
    });

    // Both this notification and the `plan`/`todoList` item arm write plan.updated.
    // Without precedence the last frame wins, flattening a real checklist into the
    // single prose entry the plan-MODE item carries.
    it('outranks the prose plan item: once it has spoken, the item arm stands down', () => {
      const afterPlan = mapCodexNotification(
        planFrame([{ step: 'one', status: 'completed' }, { step: 'two', status: 'inProgress' }]),
        state,
      );
      expect(afterPlan.state.planFromNotification).toBe(true);

      const prose = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Here is my prose plan…' } } },
        afterPlan.state,
      );
      expect(prose.events).toEqual([]);

      // …and a stray todoList snapshot is ignored for the same reason.
      const stray = mapCodexNotification(
        { method: 'item/started', params: { item: { type: 'todoList', id: 'item_t', items: [{ text: 'x', completed: false }] } } },
        afterPlan.state,
      );
      expect(stray.events).toEqual([]);
    });

    // The latch is turn-scoped. If it outlived its turn it would gag the item arm
    // for the rest of the session, stranding the dock on the previous turn's plan.
    it('re-opens the item arm on the next turn', () => {
      const latched = mapCodexNotification(planFrame([{ step: 'turn one', status: 'completed' }]), state);
      expect(latched.state.planFromNotification).toBe(true);

      const nextTurn = mapCodexNotification(
        { method: 'turn/started', params: { turn: { id: 'turn_2', status: 'inProgress' } } },
        latched.state,
      );
      expect(nextTurn.state.planFromNotification).toBe(false);

      const prose = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Turn two plan' } } },
        nextTurn.state,
      );
      expect(prose.events).toEqual([
        { type: 'plan.updated', entries: [{ content: 'Turn two plan', status: 'in_progress' }] },
      ]);
    });

    it('leaves the item arm alone until the notification actually arrives', () => {
      // The tolerance arm still works for transports that never send the notification.
      const prose = mapCodexNotification(
        { method: 'item/completed', params: { item: { type: 'plan', id: 'item_p', text: 'Prose plan' } } },
        state,
      );
      expect(prose.events).toEqual([{ type: 'plan.updated', entries: [{ content: 'Prose plan', status: 'in_progress' }] }]);
    });

    it('ignores the explanation prose (the dock renders entries only)', () => {
      const events = mapCodexNotification(
        { method: 'turn/plan/updated', params: { threadId: 'th_1', turnId: 'turn_1', explanation: 'why', plan: [{ step: 'a', status: 'pending' }] } },
        state,
      ).events;
      expect(events).toEqual([{ type: 'plan.updated', entries: [{ content: 'a', status: 'pending' }] }]);
    });
  });
});

describe('CodexAppServerRunner v2 wiring (against the bundled mock app-server)', () => {
  const mockBin = join(FIXTURES, 'mock-codex-app-server.mjs');

  it('emits v2 events through opts.onUiEvent while v1 events keep flowing', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => v1.push(e),
      { autoEndAfterFirstTurn: true, onUiEvent: (e) => v2.push(e) },
    );
    await session.result;

    // v1 stays intact (old NDJSON recordings must keep replaying).
    const v1Types = v1.map((e) => e.type);
    expect(v1Types).toContain('session');
    expect(v1Types).toContain('text');
    expect(v1Types).toContain('tool-call');
    expect(v1Types).toContain('tool-result');
    expect(v1Types).toContain('token-usage');
    expect(v1Types).toContain('turn-end');
    expect(v1Types).toContain('done');

    // v2 rides alongside: session.started exactly once and first (the
    // thread/started notification and the thread/start result path dedup).
    expect(v2[0]).toEqual({ type: 'session.started', sessionId: 'th_mock_1', backend: 'codex' });
    expect(v2.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(v2.some((e) => e.type === 'turn.started' && e.turnId === 'turn_mock_1')).toBe(true);
    expect(v2).toContainEqual({ type: 'item.delta', itemId: 'item_c1', field: 'output', delta: ' M src/example.ts\n' });
    const cmdDone = v2.find(
      (e): e is Extract<UiEvent, { type: 'item.completed' }> =>
        e.type === 'item.completed' && e.item.kind === 'tool' && e.item.id === 'item_c1',
    );
    expect(cmdDone?.item).toMatchObject({
      toolKind: 'execute',
      title: 'Ran bash -lc git status --short',
      status: 'completed',
      output: ' M src/example.ts\n',
      exitCode: 0,
    });
    expect(v2).toContainEqual({ type: 'usage.updated', usage: { input: 1200, output: 300, total: 1500 } });
    expect(v2).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_mock_1',
      stopReason: 'end_turn',
      usage: { input: 1200, output: 300, total: 1500 },
    });
  }, 30_000);

  it('normalizes collaboration telemetry while preserving the legacy stream', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:subagent-activity', cwd: process.cwd() },
      (event) => v1.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: (event) => v2.push(event) },
    );
    await session.result;
    const tools = v1.flatMap((event) => event.type === 'tool-call' ? [event.tool] : []);
    expect(tools).toContain('subAgentActivity');
    expect(tools).toContain('collabAgentToolCall');
    expect(v2.filter((event) => event.type === 'item.started' && event.item.kind === 'tool' && event.item.toolKind === 'task')).toHaveLength(1);
  }, 30_000);

  it('keeps autonomous full-access permissions when resuming a thread', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1' },
      undefined,
      { autoEndAfterFirstTurn: true },
    );

    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 30_000);

  it('retains CEZ_CODEX_NETWORK=0 as an explicit restricted-sandbox opt-out', async () => {
    vi.stubEnv('CEZ_CODEX_NETWORK', '0');
    try {
      const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
      const session = runner.startSession(
        { userPrompt: 'check without network', cwd: process.cwd() },
        undefined,
        { autoEndAfterFirstTurn: true },
      );

      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('bridges native requestUserInput to ask.requested and answers the server request', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const v2: UiEvent[] = [];
    let resolveAsk!: () => void;
    const asked = new Promise<void>((resolve) => { resolveAsk = resolve; });
    const session = runner.startSession(
      { userPrompt: 'ask me', cwd: process.cwd(), env: { MOCK_CODEX_ASK: '1' } },
      undefined,
      { autoEndAfterFirstTurn: true, onUiEvent: (event) => {
        v2.push(event);
        if (event.type === 'ask.requested') resolveAsk();
      } },
    );
    await asked;
    expect(v2).toContainEqual({
      type: 'ask.requested', requestId: 'codex-ask-1', questions: [{
        id: 'library', header: 'Library', question: 'Which test library?', multiSelect: false,
        options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
          { label: 'Node test', description: 'Use node:test.' }],
      }],
    });
    expect(session.sendMessage([{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 30_000);

  it('routes an unstructured multi-question free-text reply to the first native question', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    let resolveAsk!: () => void;
    const asked = new Promise<void>((resolve) => { resolveAsk = resolve; });
    const session = runner.startSession(
      { userPrompt: 'mock:native-codex-ask multi free text', cwd: process.cwd() },
      undefined,
      { autoEndAfterFirstTurn: true, onUiEvent: (event) => {
        if (event.type === 'ask.requested') resolveAsk();
      } },
    );
    await asked;
    expect(session.sendMessage([{ type: 'text', text: 'Use sensible defaults' }])).toBe(true);
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 30_000);

  it('rejects a failed resume through session.result without an unhandled rejection', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = runner.startSession({
        userPrompt: 'continue',
        cwd: process.cwd(),
        sessionId: 'foreign-session',
        resume: true,
        env: { MOCK_CODEX_REJECT_RESUME: '1' },
      });
      await expect(session.result).rejects.toThrow('no rollout found for thread id foreign-session');
      await new Promise((resolve) => setImmediate(resolve));
      expect(session.open).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);
});

/**
 * #528 — reasoning text must survive into the persisted `item.completed`
 * snapshot. `item.delta`s are live-only (`UiEventSink` never writes them), so
 * a completed reasoning item that carries no `content` would replay empty.
 */
describe('codex reasoning text survives replay (#528)', () => {
  const THREAD = 'th_1';
  const TURN = 'turn_1';
  const ID = 'item_rsn_1';

  function fold(frames: unknown[]): UiEvent[] {
    let state = createCodexUiState();
    const events: UiEvent[] = [];
    for (const frame of frames) {
      const mapped = mapCodexNotification(frame, state);
      state = mapped.state;
      events.push(...mapped.events);
    }
    return events;
  }

  function reasoningAt(events: UiEvent[], type: 'item.started' | 'item.completed', id = ID): UiItem | undefined {
    return events.find(
      (e): e is Extract<UiEvent, { type: 'item.started' | 'item.completed' }> =>
        e.type === type && 'item' in e && e.item.kind === 'reasoning' && e.item.id === id,
    )?.item;
  }

  /** The last reasoning text a reload would reconstruct: snapshots only. */
  function replayedText(events: UiEvent[], id = ID): string | undefined {
    let text: string | undefined;
    for (const e of events) {
      if ((e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') &&
          e.item.kind === 'reasoning' && e.item.id === id) {
        text = e.item.text;
      }
    }
    return text;
  }

  const turnStarted = { method: 'turn/started', params: { turn: { id: TURN, status: 'inProgress', items: [] } } };
  const started = (item: Record<string, unknown> = { summary: 'Tracing it' }) => ({
    method: 'item/started',
    params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: ID, ...item } },
  });
  const completed = (item: Record<string, unknown> = {}) => ({
    method: 'item/completed',
    params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: ID, ...item } },
  });
  const delta = (method: string, d: string, itemId = ID) => ({
    method: `item/reasoning/${method}`,
    params: { threadId: THREAD, turnId: TURN, itemId, delta: d },
  });
  const textDelta = (d: string) => delta('textDelta', d);

  it('falls back to the accumulated deltas when item/completed carries no content', () => {
    const events = fold([
      started(),
      textDelta('The session cookie '),
      textDelta('is dropped on refresh.'),
      // The real app-server may close a reasoning item with the summary only.
      completed({ summary: 'Tracing it' }),
    ]);
    expect(reasoningAt(events, 'item.completed')).toEqual({
      kind: 'reasoning',
      id: ID,
      text: 'The session cookie is dropped on refresh.',
    });
  });

  it('wire content still wins over the accumulator', () => {
    const events = fold([started(), textDelta('streamed'), completed({ content: 'authoritative' })]);
    expect(reasoningAt(events, 'item.completed')).toMatchObject({ text: 'authoritative' });
  });

  it('persists snapshot-only array summaries for replay', () => {
    const events = fold([
      started({ summary: [], content: [] }),
      completed({ summary: ['Inspecting the conflict.', 'Choosing the compatible resolution.'], content: [] }),
    ]);
    expect(replayedText(events)).toBe('Inspecting the conflict.\nChoosing the compatible resolution.');
  });

  it('joins array content while keeping it authoritative over streamed text', () => {
    const events = fold([
      started({ summary: [], content: [] }),
      textDelta('partial streamed text'),
      completed({ summary: ['Short summary.'], content: ['First raw part.', 'Second raw part.'] }),
    ]);
    expect(replayedText(events)).toBe('First raw part.\nSecond raw part.');
  });

  it('keeps streamed raw reasoning ahead of an array summary snapshot', () => {
    const events = fold([
      started({ summary: [], content: [] }),
      textDelta('Full streamed reasoning.'),
      completed({ summary: ['Public summary.'], content: [] }),
    ]);
    expect(replayedText(events)).toBe('Full streamed reasoning.');
  });

  it('accumulates both summary delta methods into the summary channel', () => {
    const events = fold([
      started({}),
      delta('summaryDelta', 'Checking '),
      delta('summaryTextDelta', 'the auth path.'),
      completed(),
    ]);
    expect(reasoningAt(events, 'item.completed')).toMatchObject({ text: 'Checking the auth path.' });
  });

  // The two channels are distinct streams — codex emits both when raw reasoning
  // is on. One shared bucket would persist "<raw CoT><summary>" over the summary.
  it('never concatenates the raw-thought channel with the summary channel', () => {
    const events = fold([
      started({ summary: 'Short summary.' }),
      textDelta('RAW CHAIN OF THOUGHT.'),
      delta('summaryDelta', 'Short summary.'),
      completed({ summary: 'Short summary.' }),
    ]);
    // The raw stream is the fuller text and wins outright; the summary is not appended to it.
    expect(reasoningAt(events, 'item.completed')).toMatchObject({ text: 'RAW CHAIN OF THOUGHT.' });
  });

  // A dropped frame or a mapper attached mid-turn leaves a partial accumulator.
  it('a partial streamed summary never overwrites a complete wire summary', () => {
    const events = fold([
      started({ summary: 'Full summary of the reasoning' }),
      delta('summaryDelta', 'Full sum'), // only part of the stream was seen
      completed({ summary: 'Full summary of the reasoning' }),
    ]);
    expect(reasoningAt(events, 'item.completed')).toMatchObject({ text: 'Full summary of the reasoning' });
  });

  it('the streamed summary wins when it is the fuller of the two', () => {
    const events = fold([
      started({ summary: 'Full' }),
      delta('summaryDelta', 'Full summary of the reasoning'),
      completed({ summary: 'Full' }),
    ]);
    expect(reasoningAt(events, 'item.completed')).toMatchObject({ text: 'Full summary of the reasoning' });
  });

  // A delta can outrun its item/started; the real started must not blank the row.
  it('a delta arriving before item/started is not wiped by it', () => {
    const events = fold([turnStarted, textDelta('streamed first'), started({})]);
    // The synthesized started is empty by design — the delta appends to it live.
    // The REAL item/started that follows must not blank what the stream filled.
    const starts = events.filter((e) => e.type === 'item.started');
    expect(starts).toHaveLength(2);
    expect(replayedText(events)).toBe('streamed first');
  });

  // The leak this guards is id REUSE after an item that never completed.
  it('an interrupted item’s reasoning does not leak into the next turn that reuses its id', () => {
    const events = fold([
      turnStarted,
      started({}),
      textDelta('TURN-1 SECRET REASONING'),
      // turn ends without item/completed — the item was interrupted.
      { method: 'turn/started', params: { turn: { id: 'turn_2', status: 'inProgress', items: [] } } },
      started({}),
      completed(),
    ]);
    const second = [...events].reverse().find(
      (e): e is Extract<UiEvent, { type: 'item.completed' }> =>
        e.type === 'item.completed' && e.item.kind === 'reasoning',
    );
    expect(second?.item.kind === 'reasoning' && second.item.text).toBe('');
  });

  it('does not leak one item’s reasoning into a different id in the same turn', () => {
    const events = fold([
      started(),
      textDelta('first'),
      completed(),
      {
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_2', summary: 'Next' } },
      },
      {
        method: 'item/completed',
        params: { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'item_rsn_2', summary: 'Next' } },
      },
    ]);
    expect(reasoningAt(events, 'item.completed', 'item_rsn_2')).toMatchObject({ text: 'Next' });
  });
});

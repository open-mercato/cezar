import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent, UiToolItem } from './ui-events.js';
import {
  createOmpUiState,
  mapOmpRpcMessage,
  ompTurnStarted,
  type OmpUiMapperState,
  type OmpUiMapping,
} from './omp-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'omp');
const SCENARIOS = ['tool-lifecycle', 'plan-todos', 'abort', 'session-error', 'subagent'];

function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: OmpUiMapperState = createOmpUiState();
  const events: UiEvent[] = [];
  const push = (mapped: OmpUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  // The runner writes `prompt` and only then emits `turn.started` — replay the
  // same order: seed the turn before the first wire line.
  push(ompTurnStarted(state));
  for (const line of lines) push(mapOmpRpcMessage(JSON.parse(line), state));
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('omp RPC → v2 golden fixtures', () => {
  for (const scenario of SCENARIOS) {
    it(`maps the wire-faithful "${scenario}" transcript exactly`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${scenario}.expected.json`), 'utf8'));
      expect(replay(scenario)).toStrictEqual(expected);
    });
  }

  it('malformed and unknown RPC messages are ignored without throwing', () => {
    const state = createOmpUiState();
    const benign = [
      null,
      42,
      [],
      {},
      { type: 'future_event' },
      { type: 'ready' },
      { type: 'available_commands_update', commands: [] },
      { type: 'turn_start' },
      { type: 'turn_end', message: {} },
      { type: 'agent_start' },
      { type: 'agent_end', messages: [], isTerminal: true },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } },
      { type: 'message_update', messageId: 'm', assistantMessageEvent: { type: 'toolcall_delta', delta: 'x' } },
    ] as const;
    for (const value of benign) {
      const mapped = mapOmpRpcMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('the fixture header line is skipped like any unknown frame', () => {
    const header = JSON.parse(readFileSync(join(FIXTURES, 'abort.ndjson'), 'utf8').split('\n')[0]!);
    const state = createOmpUiState();
    expect(mapOmpRpcMessage(header, state).events).toEqual([]);
  });

  it('maps prompt_result statuses onto the normalized turn reason', () => {
    const base = ompTurnStarted(createOmpUiState()).state;
    expect(mapOmpRpcMessage({ type: 'prompt_result', status: 'completed', sessionSettled: true }, base).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
    const aborted = ompTurnStarted(createOmpUiState()).state;
    expect(mapOmpRpcMessage({ type: 'prompt_result', status: 'aborted' }, aborted).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' },
    ]);
    const errored = ompTurnStarted(createOmpUiState()).state;
    expect(
      mapOmpRpcMessage({ type: 'prompt_result', status: 'error', error: { message: 'boom' } }, errored).events,
    ).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
      { type: 'session.error', message: 'boom', fatal: false },
    ]);
  });

  it('a locally-finished prompt (agentInvoked:false) still closes the turn the prompt opened', () => {
    const state = ompTurnStarted(createOmpUiState()).state;
    const mapped = mapOmpRpcMessage({ type: 'prompt_result', agentInvoked: false, sessionSettled: true }, state);
    // No usage: nothing ran. But `turn.started` was emitted when the prompt went out, so the
    // v2 stream must not leave turn_1 open — the next prompt is turn_2, not a continuation.
    expect(mapped.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
    expect(mapped.state.turnId).toBeNull();
    expect(ompTurnStarted(mapped.state).events).toEqual([{ type: 'turn.started', turnId: 'turn_2' }]);
  });

  it('an errored tool with no result.content reports the text it streamed, not a placeholder', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    state = mapOmpRpcMessage({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'rm x' } }, state).state;
    state = mapOmpRpcMessage(
      { type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'boom: permission denied' }] } },
      state,
    ).state;
    const ended = mapOmpRpcMessage({ type: 'tool_execution_end', toolCallId: 't1', isError: true, result: { details: { exitCode: 1 } } }, state);
    expect(ended.events[0]).toMatchObject({
      type: 'item.completed',
      item: { id: 't1', status: 'failed', error: 'boom: permission denied', exitCode: 1 },
    });
  });

  it('a streamed file entry without a diff cannot erase the diff toolcall_end derived', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    state = mapOmpRpcMessage(
      {
        type: 'message_update',
        messageId: 'm1',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 't1', name: 'edit', arguments: { path: 'a.ts', old_string: 'a - b', new_string: 'a + b' } },
        },
      },
      state,
    ).state;
    const derived = [{ path: 'a.ts', oldText: 'a - b', newText: 'a + b' }];
    expect(state.tools.get('t1')?.diffs).toEqual(derived);

    // A `path` with no `diff` is not a usable diff: no event, and the item keeps what it had.
    const bare = mapOmpRpcMessage(
      { type: 'tool_stream_update', toolCallId: 't1', toolName: 'edit', update: { files: [{ path: 'a.ts', op: 'update' }] } },
      state,
    );
    expect(bare.events).toEqual([]);
    expect(bare.state.tools.get('t1')?.diffs).toEqual(derived);

    // A real streamed diff is MERGED onto the same path: the old/new text survives, the unified
    // view is added; a second path is appended.
    const streamed = mapOmpRpcMessage(
      {
        type: 'tool_stream_update',
        toolCallId: 't1',
        toolName: 'edit',
        update: { files: [{ path: 'a.ts', diff: '-a - b\n+a + b' }, { path: 'b.ts', diff: '+new' }] },
      },
      bare.state,
    );
    expect(streamed.events).toHaveLength(1);
    expect((streamed.events[0] as Extract<UiEvent, { type: 'item.updated' }>).item).toMatchObject({
      diffs: [
        { path: 'a.ts', oldText: 'a - b', newText: 'a + b', unified: '-a - b\n+a + b' },
        { path: 'b.ts', oldText: null, unified: '+new' },
      ],
    });
  });

  it('maps an abandoned todo phase to cancelled — dropped, not finished', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    state = mapOmpRpcMessage({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'todo', args: { op: 'init' } }, state).state;
    const ended = mapOmpRpcMessage(
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'todo',
        result: {
          content: [{ type: 'text', text: 'ok' }],
          details: {
            phases: [{
              tasks: [
                { content: 'read', status: 'completed' },
                { content: 'rewrite', status: 'abandoned' },
                { content: 'test', status: 'in_progress' },
                { content: 'ship', status: 'blocked' },
              ],
            }],
          },
        },
      },
      state,
    );
    expect(ended.events.find((event) => event.type === 'plan.updated')).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'read', status: 'completed' },
        { content: 'rewrite', status: 'cancelled' },
        { content: 'test', status: 'in_progress' },
        { content: 'ship', status: 'pending' },
      ],
    });
  });

  it('does not double-start the same tool from toolcall_end and tool_execution_start', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    const first = mapOmpRpcMessage(
      {
        type: 'message_update',
        messageId: 'm1',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
        },
      },
      state,
    );
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ type: 'item.started', item: { id: 't1', status: 'pending' } });
    state = first.state;
    const second = mapOmpRpcMessage(
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      state,
    );
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ type: 'item.updated', item: { id: 't1', status: 'running' } });
    const updated = second.events[0] as Extract<UiEvent, { type: 'item.updated' }>;
    expect((updated.item as UiToolItem).input).toEqual({ path: 'a.ts' });
  });

  it('accumulates usage across model rounds: session-cumulative updates, summed turn totals', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    state = mapOmpRpcMessage(
      {
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115, cost: { total: 0.001 } } },
      },
      state,
    ).state;
    const second = mapOmpRpcMessage(
      {
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.002 } } },
      },
      state,
    );
    expect(second.events).toEqual([
      { type: 'usage.updated', usage: { input: 13, output: 12, total: 125, cacheRead: 100, cacheWrite: 0 }, costUsd: 0.003 },
    ]);
    const settled = mapOmpRpcMessage({ type: 'prompt_result', status: 'completed', sessionSettled: true }, second.state);
    expect(settled.events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn', usage: { input: 13, output: 12, total: 125, cacheRead: 100, cacheWrite: 0 }, costUsd: 0.003 },
    ]);

    // A second turn: the session total keeps growing, the turn total starts from zero.
    let next = ompTurnStarted(settled.state).state;
    const third = mapOmpRpcMessage(
      {
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21, cost: { total: 0.004 } } },
      },
      next,
    );
    expect(third.events).toEqual([
      { type: 'usage.updated', usage: { input: 33, output: 13, total: 146, cacheRead: 100, cacheWrite: 0 }, costUsd: 0.007 },
    ]);
    next = third.state;
    const settledAgain = mapOmpRpcMessage({ type: 'prompt_result', status: 'completed', sessionSettled: true }, next);
    expect(settledAgain.events).toEqual([
      { type: 'turn.completed', turnId: 'turn_2', stopReason: 'end_turn', usage: { input: 20, output: 1, total: 21, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.004 },
    ]);
    // A turn omp ends without any usage reports none — it does not inherit the previous turn's.
    const quiet = mapOmpRpcMessage({ type: 'prompt_result', status: 'completed', sessionSettled: true }, ompTurnStarted(settledAgain.state).state);
    expect(quiet.events).toEqual([{ type: 'turn.completed', turnId: 'turn_3', stopReason: 'end_turn' }]);
  });
});

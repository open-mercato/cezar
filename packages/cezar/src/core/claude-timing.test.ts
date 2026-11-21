/** Per-API-call `timing` events from `stream_event` frames (#1543). */
import { describe, expect, it } from 'vitest';
import { closeOpenCalls, createClaudeUiState, mapClaudeMessage, type ClaudeUiMapperState } from './claude-ui-mapper.ts';
import type { UiEvent, UiTimingEvent } from './ui-events.ts';

const se = (event: Record<string, unknown>, parent: string | null = null) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
});
const start = (id: string, parent: string | null = null) => se({ type: 'message_start', message: { id, model: 'claude-x' } }, parent);
const delta = (type = 'text_delta', parent: string | null = null) =>
  se({ type: 'content_block_delta', index: 0, delta: { type, text: 'hi', partial_json: '{' } }, parent);
const end = (tokens: number, parent: string | null = null) =>
  se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: tokens } }, parent);

function run(frames: unknown[]): { timing: UiTimingEvent[]; state: ClaudeUiMapperState; all: UiEvent[] } {
  let state = createClaudeUiState();
  const all: UiEvent[] = [];
  for (const frame of frames) {
    const mapped = mapClaudeMessage(frame, state);
    state = mapped.state;
    all.push(...mapped.events);
  }
  return { timing: all.filter((e): e is UiTimingEvent => e.type === 'timing'), state, all };
}

const phases = (t: UiTimingEvent[]): string[] => t.map((e) => (e.phase === 'aborted' ? `aborted:${e.reason}` : e.phase));

describe('claude timing events', () => {
  it('start, first-delta, end in order with output_tokens and stop_reason', () => {
    const { timing } = run([start('m1'), delta(), delta(), end(42)]);
    expect(timing).toEqual([
      { type: 'timing', phase: 'start', messageId: 'm1', model: 'claude-x' },
      { type: 'timing', phase: 'first-delta', messageId: 'm1' },
      { type: 'timing', phase: 'end', messageId: 'm1', output_tokens: 42, stop_reason: 'end_turn' },
    ]);
  });

  it('a tool-use-only response still gets first-delta from its input_json_delta', () => {
    const { timing } = run([start('m1'), se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }), end(5)]);
    expect(phases(timing)).toEqual(['start', 'first-delta', 'end']);
  });

  it('sub-agent calls carry parentToolUseId and do not close the main thread call', () => {
    const { timing } = run([start('m1'), start('s1', 'toolu_1'), delta('text_delta', 'toolu_1'), end(3, 'toolu_1'), delta(), end(9)]);
    expect(timing.filter((e) => e.parentToolUseId === 'toolu_1').map((e) => e.phase)).toEqual(['start', 'first-delta', 'end']);
    expect(timing.filter((e) => e.parentToolUseId === undefined).map((e) => e.phase)).toEqual(['start', 'first-delta', 'end']);
  });

  it('error mid-stream aborts with the API error type only', () => {
    const { timing, state } = run([start('m1'), delta(), se({ type: 'error', error: { type: 'overloaded_error', message: 'secret text' } })]);
    expect(timing.at(-1)).toEqual({ type: 'timing', phase: 'aborted', messageId: 'm1', reason: 'error', errorType: 'overloaded_error' });
    expect(phases(timing)).toEqual(['start', 'first-delta', 'aborted:error']);
    expect(state.calls.size).toBe(0);
  });

  it('error before the first delta leaves first-delta absent', () => {
    const { timing } = run([start('m1'), se({ type: 'error', error: { type: 'api_error' } })]);
    expect(phases(timing)).toEqual(['start', 'aborted:error']);
  });

  it('a retry (second message_start) closes the previous call as aborted/error', () => {
    const { timing } = run([start('m1'), start('m2'), delta(), end(1)]);
    expect(phases(timing)).toEqual(['start', 'aborted:error', 'start', 'first-delta', 'end']);
    expect(timing[1]?.messageId).toBe('m1');
  });

  it('a result without end closes the call as stream-ended, an error result as error', () => {
    expect(phases(run([start('m1'), delta(), { type: 'result', subtype: 'success' }]).timing)).toEqual(['start', 'first-delta', 'aborted:stream-ended']);
    expect(phases(run([start('m1'), { type: 'result', subtype: 'error_during_execution', is_error: true }]).timing)).toEqual(['start', 'aborted:error']);
  });

  it('cancel/exit closes every open call (closeOpenCalls)', () => {
    const { state } = run([start('m1'), start('s1', 'toolu_1')]);
    const closed = closeOpenCalls(state, 'cancelled');
    expect(closed.events.map((e) => (e as UiTimingEvent).reason)).toEqual(['cancelled', 'cancelled']);
    expect(closeOpenCalls(closed.state, 'cancelled').events).toEqual([]);
  });

  it('a message_delta without usage, or frames with no open call, emit nothing', () => {
    expect(run([start('m1'), se({ type: 'message_delta', delta: { stop_reason: 'x' } })]).timing).toHaveLength(1);
    expect(run([delta(), end(3), se({ type: 'error', error: {} })]).timing).toEqual([]);
  });

  it('timing never changes rendered items', () => {
    const withTiming = run([start('m1'), delta(), { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }]).all.filter((e) => e.type !== 'timing');
    const without = run([delta(), { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }]).all;
    expect(withTiming).toEqual(without);
  });
});

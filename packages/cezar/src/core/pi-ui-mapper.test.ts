import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.js';
import {
  createPiUiState,
  mapPiRpcMessage,
  piTurnStarted,
  type PiUiMapperState,
  type PiUiMapping,
} from './pi-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'pi');

function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: PiUiMapperState = createPiUiState();
  const events: UiEvent[] = [];
  const push = (mapped: PiUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(piTurnStarted(state));
  for (const line of lines) push(mapPiRpcMessage(JSON.parse(line), state));
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('pi RPC → v2 golden fixture', () => {
  it('maps the wire-faithful lifecycle exactly', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'rpc-lifecycle.expected.json'), 'utf8'));
    expect(replay('rpc-lifecycle')).toStrictEqual(expected);
  });

  it('malformed and unknown RPC messages are ignored without throwing', () => {
    const state = createPiUiState();
    for (const value of [null, 42, [], {}, { type: 'future_event' }]) {
      const mapped = mapPiRpcMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('maps upstream model stop reasons onto the normalized turn reason', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'done', reason: 'length', message: {} },
      },
      state,
    ).state;
    expect(mapPiRpcMessage({ type: 'agent_settled' }, state).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'max_tokens' },
    ]);
  });

  it('gives each assistant message distinct item identities when content indexes restart', () => {
    let state = piTurnStarted(createPiUiState()).state;
    const events: UiEvent[] = [];
    const push = (value: unknown): void => {
      const mapped = mapPiRpcMessage(value, state);
      state = mapped.state;
      events.push(...mapped.events);
    };

    push({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'first' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'first' } });
    push({ type: 'message_end', message: { role: 'assistant' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'second' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'second' } });

    expect(events.filter((event) => event.type === 'item.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'item.completed').map((event) => event.item.id)).toEqual([
      'turn_1_message_0_text_0',
      'turn_1_message_1_text_0',
    ]);
  });

  it('resets per-turn message identity and bookkeeping at settlement', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'one' } },
      state,
    ).state;
    state = mapPiRpcMessage({ type: 'message_end', message: { role: 'assistant' } }, state).state;
    state = mapPiRpcMessage({ type: 'agent_settled' }, state).state;
    expect(state.turnId).toBeNull();
    expect(state.startedItems).toHaveLength(0);
    expect(state.textByItem).toHaveLength(0);

    state = piTurnStarted(state).state;
    expect(mapPiRpcMessage(
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      state,
    ).events[0]).toEqual({
      type: 'item.started',
      item: { kind: 'message', id: 'turn_2_message_0_text_0', role: 'assistant', text: '' },
    });
  });

  it('keeps reasoning blocks and interleaved tools attached to their own assistant messages', () => {
    let state = piTurnStarted(createPiUiState()).state;
    const events: UiEvent[] = [];
    const push = (value: unknown): void => {
      const mapped = mapPiRpcMessage(value, state);
      state = mapped.state;
      events.push(...mapped.events);
    };

    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'first thought' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'first thought' } });
    push({ type: 'message_end', message: { role: 'assistant' } });
    push({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' } });
    push({ type: 'tool_execution_end', toolCallId: 'read-1', result: { content: 'ok' }, isError: false });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'second thought' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'second thought' } });

    expect(events.filter((event) => event.type === 'item.started').map((event) => event.item.id)).toEqual([
      'turn_1_message_0_reasoning_0',
      'read-1',
      'turn_1_message_1_reasoning_0',
    ]);
    expect(events.filter((event) => event.type === 'item.completed').map((event) => event.item.id)).toEqual([
      'turn_1_message_0_reasoning_0',
      'read-1',
      'turn_1_message_1_reasoning_0',
    ]);
  });

  it('does not concatenate messages when text_end omits content', () => {
    let state = piTurnStarted(createPiUiState()).state;
    const completed: Extract<UiEvent, { type: 'item.completed' }>[] = [];
    const push = (value: unknown): void => {
      const mapped = mapPiRpcMessage(value, state);
      state = mapped.state;
      completed.push(...mapped.events.filter((event): event is Extract<UiEvent, { type: 'item.completed' }> => event.type === 'item.completed'));
    };

    push({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'first' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0 } });
    push({ type: 'message_end', message: { role: 'assistant' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'second' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0 } });

    expect(completed.map((event) => [event.item.id, event.item.kind === 'message' ? event.item.text : undefined])).toEqual([
      ['turn_1_message_0_text_0', 'first'],
      ['turn_1_message_1_text_0', 'second'],
    ]);
  });

  it('completes a tool whose result lands after a mid-turn steer starts a new turn', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      { type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' } },
      state,
    ).state;
    // Steering while the tool still runs: pi-runner calls piTurnStarted again mid-turn, so the
    // per-message reset must not drop tool calls keyed by pi's session-unique toolCallId.
    state = piTurnStarted(state).state;
    const ended = mapPiRpcMessage(
      { type: 'tool_execution_end', toolCallId: 'read-1', result: { content: 'ok' }, isError: false },
      state,
    );

    expect(ended.events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ kind: 'tool', id: 'read-1', status: 'completed' }) },
    ]);
  });

  it('settles an interrupted stream and clears unfinished item bookkeeping', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } },
      state,
    ).state;
    const interrupted = mapPiRpcMessage(
      { type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted', error: { errorMessage: 'cancelled' } } },
      state,
    );
    const settled = mapPiRpcMessage({ type: 'agent_settled' }, interrupted.state);

    expect(interrupted.events).toContainEqual({ type: 'session.error', message: 'cancelled', fatal: false });
    expect(settled.events).toContainEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' });
    expect(settled.state.turnId).toBeNull();
    expect(settled.state.startedItems).toHaveLength(0);
    expect(settled.state.textByItem).toHaveLength(0);
    expect(settled.state.tools).toHaveLength(0);
  });
});

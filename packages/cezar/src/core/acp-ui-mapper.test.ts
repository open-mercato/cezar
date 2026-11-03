import { describe, expect, it } from 'vitest';

import {
  createAcpUiState,
  endAcpReplay,
  mapAcpFrame,
  stopReasonOf,
  type AcpDialect,
  type AcpUiMapperState,
} from './acp-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * The shared ACP mapper, on protocol features a real Gemini 0.60 session never produced. The frame
 * shapes follow the ACP SDK's own zod schemas as bundled in `@google/gemini-cli` 0.60.0
 * (`zPlan`/`zPlanEntry`, `zUsage` on `zPromptResponse`, `zStopReason`); the per-runner golden fixtures
 * (`gemini-ui-mapper.test.ts`) pin what a real agent actually sends.
 */
const dialect: AcpDialect = {
  backend: 'claude', // any runner id: the generic mapper only echoes it on session.started
  toolNameOf: (update) => (typeof update.toolCallId === 'string' ? update.toolCallId.split('-')[0]! : 'tool'),
};

function drive(frames: unknown[], d: AcpDialect = dialect, start: AcpUiMapperState = createAcpUiState()) {
  let state = start;
  const events: UiEvent[] = [];
  for (const frame of frames) {
    const mapped = mapAcpFrame(frame, state, d);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return { events, state };
}

const out = (frame: unknown) => ({ dir: 'out', frame });
const inbound = (frame: unknown) => ({ dir: 'in', frame });
const update = (u: Record<string, unknown>) => inbound({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: u } });
const openTurn = [
  out({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/repo', mcpServers: [] } }),
  inbound({ jsonrpc: '2.0', id: 1, result: { sessionId: 's' } }),
  out({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's', prompt: [] } }),
];

describe('ACP → v2 mapper (shared layer)', () => {
  it('maps an ACP plan update as a full replacement, normalizing unknown statuses and dropping bad entries', () => {
    const { events } = drive([
      ...openTurn,
      update({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Reproduce', priority: 'high', status: 'completed' },
          { content: 'Fix', priority: 'medium', status: 'in_progress' },
          { content: 'Ship', priority: 'weird', status: 'someday' },
          { priority: 'low', status: 'pending' },
          'junk',
        ],
      }),
      update({ sessionUpdate: 'plan', entries: [] }),
    ]);
    expect(events.filter((e) => e.type === 'plan.updated')).toEqual([
      {
        type: 'plan.updated',
        entries: [
          { content: 'Reproduce', status: 'completed', priority: 'high' },
          { content: 'Fix', status: 'in_progress', priority: 'medium' },
          { content: 'Ship', status: 'pending' },
        ],
      },
      // Only a genuinely empty list clears the dock.
      { type: 'plan.updated', entries: [] },
    ]);
  });

  it('reads the standard PromptResponse.usage and accumulates usage.updated across turns', () => {
    const { events } = drive([
      ...openTurn,
      inbound({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, totalTokens: 18 } } }),
      out({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} }),
      inbound({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }),
    ]);
    expect(events.filter((e) => e.type === 'usage.updated' || e.type === 'turn.completed')).toEqual([
      { type: 'usage.updated', usage: { input: 10, output: 5, total: 18, cacheRead: 3 } },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn', usage: { input: 10, output: 5, total: 18, cacheRead: 3 } },
      { type: 'usage.updated', usage: { input: 11, output: 6, total: 20, cacheRead: 3 } },
      { type: 'turn.completed', turnId: 'turn_2', stopReason: 'end_turn', usage: { input: 1, output: 1, total: 2 } },
    ]);
  });

  it('maps every ACP stop reason onto the v2 vocabulary', () => {
    expect(stopReasonOf('end_turn')).toBe('end_turn');
    expect(stopReasonOf('max_tokens')).toBe('max_tokens');
    expect(stopReasonOf('max_turn_requests')).toBe('max_tokens');
    expect(stopReasonOf('refusal')).toBe('refusal');
    expect(stopReasonOf('cancelled')).toBe('cancelled');
  });

  it('settles a tool a cancelled turn left running as failed, so no card spins forever', () => {
    const { events } = drive([
      ...openTurn,
      update({ sessionUpdate: 'tool_call', toolCallId: 'bash-1', status: 'in_progress', title: 'sleep 60', kind: 'execute' }),
      inbound({ jsonrpc: '2.0', id: 2, result: { stopReason: 'cancelled' } }),
    ]);
    expect(events.slice(-2)).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'bash-1',
          name: 'bash',
          toolKind: 'execute',
          title: 'sleep 60',
          status: 'failed',
          error: 'turn ended (cancelled) before the tool finished',
        },
      },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' },
    ]);
  });

  it('keeps the rawInput an agent does send, and lets a dialect read a plan out of a tool call', () => {
    const planning: AcpDialect = {
      ...dialect,
      planFromToolCall: (name, u) =>
        name === 'todo' && Array.isArray((u.rawInput as { items?: unknown } | undefined)?.items)
          ? [{ content: 'from the tool', status: 'pending' }]
          : undefined,
    };
    const { events } = drive(
      [...openTurn, update({ sessionUpdate: 'tool_call', toolCallId: 'todo-1', status: 'in_progress', title: 'Plan', rawInput: { items: [1] } })],
      planning,
    );
    expect(events.slice(-2)).toEqual([
      {
        type: 'item.started',
        item: { kind: 'tool', id: 'todo-1', name: 'todo', toolKind: 'other', title: 'Plan', status: 'running', input: { items: [1] } },
      },
      { type: 'plan.updated', entries: [{ content: 'from the tool', status: 'pending' }] },
    ]);
  });

  it('ends a load replay on the runner’s say-so when the agent never sends the marker', () => {
    let { state } = drive([out({ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 's', cwd: '/r' } })]);
    expect(state.replaying).toBe(true);
    state = endAcpReplay(state);
    const { events } = drive(
      [
        out({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: {} }),
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } }),
      ],
      dialect,
      state,
    );
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'item.started', 'item.delta']);
  });

  it('never mutates the state it was given', () => {
    const { state } = drive(openTurn);
    const snapshot = JSON.stringify({ ...state, requests: [...state.requests], tools: [...state.tools] });
    mapAcpFrame(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }), state, dialect);
    mapAcpFrame(update({ sessionUpdate: 'tool_call', toolCallId: 't-1', status: 'in_progress' }), state, dialect);
    mapAcpFrame(inbound({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }), state, dialect);
    expect(JSON.stringify({ ...state, requests: [...state.requests], tools: [...state.tools] })).toBe(snapshot);
  });
});

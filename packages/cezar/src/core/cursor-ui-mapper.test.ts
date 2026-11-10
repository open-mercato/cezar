/**
 * Golden tests for the Cursor stream-json → v2 mapper.
 * Wire shapes from https://cursor.com/docs/cli/reference/output-format
 * and the dry-run mock `scripts/mock-cursor-agent.mjs`.
 *
 * Provenance (#807 review): verified against that page — the terminal `result` frame is
 * exactly `{type, subtype, is_error, duration_ms, duration_api_ms, result, session_id,
 * request_id}` (no `usage`/`total_cost_usd`); `thinking` events are documented as suppressed
 * in print mode and never appear in any output format; `readToolCall`/`writeToolCall` and the
 * generic `tool_call.function` wrapper for "other tools" are documented. NOT verified against
 * that page: the `editToolCall`/`shellToolCall` wrapper names, and the `TodoWrite`/`Task` tool
 * names and their argument shapes under `tool_call.function` — no live `agent` CLI was
 * available to capture a real transcript. Treat those specific shapes as best-effort until
 * confirmed against a real transcript (see AGENT_PROTOCOL.md §7's wire-faithful fixture rule).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent } from './ui-events.ts';
import {
  createCursorUiState,
  mapCursorMessage,
  mapCursorStreamEvent,
  type CursorUiMapping,
} from './cursor-ui-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'cursor');

function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createCursorUiState();
  const events: UiEvent[] = [];
  const push = (mapped: CursorUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    push(mapCursorMessage(msg, state));
  }
  return events;
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

const GOLDEN_FIXTURES = ['text-turn', 'tools-plan-task'] as const;

describe('cursor → v2 golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(expectedEvents(fixture));
    });
  }
});

describe('mapCursorMessage edge cases', () => {
  const state = createCursorUiState();

  it('non-object and unknown message types produce no events and never throw', () => {
    for (const msg of [null, undefined, 42, 'assistant', [], {}, { type: 'user' }, { type: 'thinking' }]) {
      const mapped = mapCursorMessage(msg, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('skips assistant partial flushes that carry model_call_id', () => {
    const mapped = mapCursorMessage(
      {
        type: 'assistant',
        model_call_id: 'x',
        message: { role: 'assistant', content: [{ type: 'text', text: 'dup' }] },
      },
      state,
    );
    expect(mapped.events).toEqual([]);
  });

  it('gives a tool still open when the turn ends a terminal snapshot instead of leaving it running', () => {
    const started = mapCursorMessage(
      { type: 'tool_call', subtype: 'started', call_id: 'call_1', tool_call: { shellToolCall: { args: { command: 'npm test' } } } },
      state,
    );
    const result = mapCursorMessage({ type: 'result', subtype: 'success', is_error: true, result: 'interrupted' }, started.state);
    const snapshot = result.events.find(
      (e) => e.type === 'item.completed' && e.item.id === 'call_1',
    );
    expect(snapshot?.type).toBe('item.completed');
    expect(snapshot && 'item' in snapshot && 'status' in snapshot.item ? snapshot.item.status : undefined).toBe('failed');
    expect(result.state.openTools.size).toBe(0);
  });

  it('emits plan.updated with an empty entries array when a TodoWrite clears the plan', () => {
    const mapped = mapCursorMessage(
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call_todo',
        tool_call: { function: { name: 'TodoWrite', arguments: '{"todos":[]}' } },
      },
      state,
    );
    expect(mapped.events).toContainEqual({ type: 'plan.updated', entries: [] });
  });
});

describe('mapCursorStreamEvent (v1)', () => {
  it('derives isError from the tool result instead of always reporting success', () => {
    const events = mapCursorStreamEvent({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call_1',
      tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { error: { errorMessage: 'boom' } } } },
    });
    expect(events).toEqual([
      { type: 'tool-result', toolCallId: 'call_1', result: JSON.stringify({ error: { errorMessage: 'boom' } }), isError: true },
    ]);
  });

  it('maps result usage and cost into v1 telemetry events', () => {
    const events = mapCursorStreamEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 100, output_tokens: 50 },
      total_cost_usd: 0.02,
    });
    expect(events).toContainEqual({ type: 'token-usage', tokensUsed: 150 });
    expect(events).toContainEqual({ type: 'cost', usd: 0.02 });
  });
});

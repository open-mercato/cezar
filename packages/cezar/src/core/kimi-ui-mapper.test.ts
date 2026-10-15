import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.js';
import {
  abortKimiTurn,
  createKimiUiState,
  kimiSessionStarted,
  kimiTurnStarted,
  mapKimiMessage,
  type KimiUiMapperState,
  type KimiUiMapping,
} from './kimi-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'kimi');

/**
 * Replays a capture the way `KimiRunner` feeds its mapper: the session starts just before the
 * first prompt (once the model is selected, with the latest `configOptions` the agent answered),
 * each `session/prompt` the client sent starts a turn, every agent message is mapped, and Kimi's
 * own `usage.record` lines (read from its session log) are mapped where they fall — the runner
 * reads them before the prompt response.
 *
 * `acp-session.ndjson` is a real two-turn `kimi acp` session (Kimi Code 2.1.1, model
 * kimi-code/k3, 2026-09-30) captured through a transparent tap, with the session-log usage
 * records interleaved by timestamp; only the scratch path was rewritten to `/work/repo`, and the
 * bulky `available_commands_update`/`config_option_update` notifications (ignored by the mapper)
 * were dropped.
 */
function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: KimiUiMapperState = createKimiUiState();
  const events: UiEvent[] = [];
  const push = (mapped: KimiUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  let sessionId: string | undefined;
  let configOptions: unknown;
  for (const line of lines) {
    const { dir, msg } = JSON.parse(line) as { dir: string; msg: Record<string, unknown> };
    if (dir === 'client->agent') {
      if (msg.method !== 'session/prompt') continue;
      if (sessionId) push(kimiSessionStarted(state, sessionId, configOptions));
      push(kimiTurnStarted(state));
      continue;
    }
    const result = msg.result as Record<string, unknown> | undefined;
    if (typeof result?.sessionId === 'string') sessionId = result.sessionId;
    if (result?.configOptions) configOptions = result.configOptions;
    push(mapKimiMessage(msg, state));
  }
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('kimi ACP → v2 golden fixture', () => {
  it('maps the wire-faithful session exactly', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'acp-session.expected.json'), 'utf8'));
    expect(replay('acp-session')).toStrictEqual(expected);
  });

  it('carries each turn’s summed session-log usage on turn.completed, and never the next turn’s', () => {
    const turns = replay('acp-session').filter(
      (e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed',
    );
    expect(turns.map((t) => t.turnId)).toEqual(['turn_1', 'turn_2']);
    // Six main-agent LLM requests in turn 1; turn 2 bills the explore sub-agent's two as well.
    expect(turns[0]!.usage).toMatchObject({ input: 2995, output: 667, cacheRead: 120_320, cacheWrite: 0, total: 123_982 });
    expect(turns[1]!.usage?.input).toBeGreaterThan(0);
    expect(turns[1]!.usage?.input).toBeLessThan(turns[0]!.usage!.input);
  });

  it('reports one plan per TodoList change even though Kimi sends it twice', () => {
    const plans = replay('acp-session').filter((e) => e.type === 'plan.updated');
    const keys = plans.map((p) => JSON.stringify(p));
    expect(plans.length).toBe(4);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('opens no reasoning item for Kimi’s empty opening thought chunk', () => {
    const reasoning = replay('acp-session').filter(
      (e) => e.type === 'item.completed' && e.item.kind === 'reasoning',
    ) as Array<Extract<UiEvent, { type: 'item.completed' }>>;
    expect(reasoning.length).toBeGreaterThan(0);
    for (const e of reasoning) expect((e.item as { text: string }).text.trim()).not.toBe('');
  });

  it('ignores malformed and unknown messages without throwing', () => {
    const state = createKimiUiState();
    for (const value of [null, 42, [], {}, { method: 'session/update' }, { method: 'session/update', params: { update: { sessionUpdate: 'future' } } }]) {
      const mapped = mapKimiMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('ends the turn when the prompt itself fails (a quota 403 arrives as a JSON-RPC error)', () => {
    const state = kimiTurnStarted(createKimiUiState()).state;
    const message = "Authentication required: 403 You've reached your weekly (7-day) usage limit.";
    expect(mapKimiMessage({ jsonrpc: '2.0', id: 5, error: { code: -32000, message } }, state).events).toEqual([
      { type: 'session.error', message, fatal: false },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
  });

  it('starts the session once, whether from session/new or a resumed id', () => {
    const configOptions = [{ id: 'model', currentValue: 'kimi-code/k3' }];
    const started = kimiSessionStarted(createKimiUiState(), 'session_x', configOptions);
    expect(started.events).toEqual([
      { type: 'session.started', sessionId: 'session_x', backend: 'kimi', model: 'kimi-code/k3' },
    ]);
    expect(kimiSessionStarted(started.state, 'session_x', configOptions).events).toEqual([]);
    // A `session/new` result is not itself the start: the model may still be switched after it.
    expect(mapKimiMessage({ id: 2, result: { sessionId: 'session_x', configOptions } }, createKimiUiState()).events).toEqual([]);
  });

  it('maps ACP stop reasons onto the protocol’s', () => {
    for (const [wire, expected] of [
      ['end_turn', 'end_turn'],
      ['max_tokens', 'max_tokens'],
      ['max_turn_requests', 'max_tokens'],
      ['refusal', 'refusal'],
      ['cancelled', 'cancelled'],
    ] as const) {
      const state = kimiTurnStarted(createKimiUiState()).state;
      expect(mapKimiMessage({ id: 3, result: { stopReason: wire } }, state).events).toEqual([
        { type: 'turn.completed', turnId: 'turn_1', stopReason: expected },
      ]);
    }
  });

  it('settles a tool a cancelled turn left running, instead of leaving it spinning', () => {
    let state = kimiTurnStarted(createKimiUiState()).state;
    state = mapKimiMessage(
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', kind: 'execute' } } },
      state,
    ).state;
    expect(mapKimiMessage({ id: 3, result: { stopReason: 'cancelled' } }, state).events).toEqual([
      {
        type: 'item.completed',
        item: expect.objectContaining({ id: 't1', status: 'failed', error: 'turn ended (cancelled) before the tool finished' }),
      },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' },
    ]);
  });

  it('aborts a turn no answer will end: as an error with a message, else with the given reason', () => {
    let state = kimiTurnStarted(createKimiUiState()).state;
    state = mapKimiMessage(
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read' } } },
      state,
    ).state;
    expect(abortKimiTurn(state, 'error', 'kimi acp exited').events).toEqual([
      { type: 'item.completed', item: expect.objectContaining({ id: 't1', status: 'failed' }) },
      { type: 'session.error', message: 'kimi acp exited', fatal: false },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
    expect(abortKimiTurn(state, 'timeout').events.at(-1)).toEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'timeout' });
    expect(abortKimiTurn(createKimiUiState(), 'cancelled').events).toEqual([]);
  });
});

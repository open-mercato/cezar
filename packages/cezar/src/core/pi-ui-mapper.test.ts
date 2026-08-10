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
});

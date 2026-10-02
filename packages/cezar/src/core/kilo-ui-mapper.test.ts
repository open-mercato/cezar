import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import {
  createKiloUiState,
  kiloTurnCompleted,
  mapKiloMessage,
  mapKiloStreamEvent,
  type KiloUiMapperState,
  type KiloUiMapping,
} from './kilo-ui-mapper.ts';

/**
 * Kilo `run --format json` → v2 golden fixtures.
 *
 * Provenance: captured from a real `kilo run --auto --format json` (kilo
 * 7.7.9) — a text-only turn, a bash tool turn, and a rate-limited error turn.
 * Transport-noise fields trimmed, documented per fixture: `vercelID` /
 * `metrics` routing telemetry on `step-finish` parts, and the error frame's
 * `responseHeaders` / `responseBody` HTTP blobs. Every field the mapper reads
 * (`text`, tool `callID`/`tool`/`state`, `tokens`, `cost`, `error.data.message`)
 * is verbatim.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'kilo');

function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: KiloUiMapperState = createKiloUiState();
  const events: UiEvent[] = [];
  const push = (mapped: KiloUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  for (const line of lines) push(mapKiloMessage(JSON.parse(line), state));
  push(kiloTurnCompleted(state));
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('kilo run json → v2 golden fixtures', () => {
  it.each(['text-only', 'tool-use', 'error'])('maps the %s wire faithfully', (fixture) => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
    expect(replay(fixture)).toStrictEqual(expected);
  });

  it('malformed and unknown lines are ignored without throwing', () => {
    const state = createKiloUiState();
    for (const value of [null, 42, [], {}, { type: 'future_event' }]) {
      const mapped = mapKiloMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('maps a non-completed terminal tool status to failed', () => {
    let state = createKiloUiState();
    const mapped = mapKiloMessage(
      {
        type: 'tool_use',
        sessionID: 'ses_x',
        part: {
          id: 'prt_x',
          sessionID: 'ses_x',
          messageID: 'msg_x',
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'error', input: { command: 'exit 3' }, output: 'boom' },
        },
      },
      state,
    );
    state = mapped.state;
    const completed = mapped.events.filter((e) => e.type === 'item.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ item: { status: 'failed', output: 'boom' } });
    // v1 reports the same failure on the tool-result.
    expect(mapKiloStreamEvent({
      type: 'tool_use',
      part: {
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'error', output: 'boom' },
      },
    })).toEqual([
      { type: 'tool-call', id: 'call_1', tool: 'bash', input: undefined },
      { type: 'tool-result', toolCallId: 'call_1', result: 'boom', isError: true },
    ]);
  });

  it('reports error frames as v1 errors with the vendor message', () => {
    expect(
      mapKiloStreamEvent({
        type: 'error',
        sessionID: 'ses_x',
        error: { name: 'APIError', data: { message: 'rate limited' } },
      }),
    ).toEqual([{ type: 'error', message: 'kilo: rate limited' }]);
  });
});

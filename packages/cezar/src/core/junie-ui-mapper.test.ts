/**
 * Golden tests for the junie ACP → v2 mapper. Both fixtures are wire-faithful
 * transcripts captured live against a real, authenticated `junie --acp=true`
 * session (`@jetbrains/junie` 26.9.22) — see `junie-ui-mapper.ts`'s module doc
 * for exactly what was observed vs. mapped from the public ACP schema.
 *
 * junie's turn boundary is a JSON-RPC RESPONSE (`session/prompt`'s result),
 * not a notification like codex's `turn/completed` or pi's `agent_settled` —
 * so unlike those two mappers' fixtures, a junie fixture's last line is a
 * `{"id":…,"result":{"stopReason":…,"usage":…}}` frame, and `replay()` below
 * branches on shape exactly as `JunieSession.dispatch`/`runTurn` do: a
 * notification goes through `mapJunieSessionUpdate`, a response resolves the
 * turn through `junieTurnCompleted`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import {
  createJunieUiState,
  junieSessionStarted,
  junieStopReason,
  junieTurnCompleted,
  junieTurnStarted,
  junieUsageFromResponse,
  mapJunieSessionUpdate,
  type JunieUiMapperState,
} from './junie-ui-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'junie');

/** Replay a fixture exactly as the runner drives the mapper: session +
 *  turn seeded before the first line (the runner calls these off RESPONSE
 *  frames the pure notification stream never carries), malformed lines
 *  skipped. */
function replay(fixture: string, sessionId = 'session-fixture'): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state: JunieUiMapperState = createJunieUiState();
  const events: UiEvent[] = [];
  const push = (mapped: { events: UiEvent[]; state: JunieUiMapperState }): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(junieSessionStarted(sessionId, state));
  push(junieTurnStarted(state));
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== 'object') continue;
    const frame = msg as { id?: unknown; method?: unknown; params?: { update?: unknown }; result?: unknown };
    if (frame.id !== undefined && frame.result !== undefined && typeof frame.result === 'object') {
      const result = frame.result as { stopReason?: unknown; usage?: unknown };
      push(junieTurnCompleted(junieStopReason(result.stopReason), junieUsageFromResponse(result.usage), state));
    } else if (frame.method === 'session/update') {
      push(mapJunieSessionUpdate(frame.params?.update, state));
    }
  }
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

describe('junie ACP → v2 golden fixtures', () => {
  it('maps a multi-tool turn (failing command, succeeding command, file edit) exactly', () => {
    expect(replay('tool-lifecycle', 'session-260927-141912-1jcp')).toStrictEqual(expectedEvents('tool-lifecycle'));
  });

  it('maps a session/cancel-interrupted turn exactly', () => {
    expect(replay('cancelled-turn', 'session-260927-141912-1jcp')).toStrictEqual(expectedEvents('cancelled-turn'));
  });

  // `agent_thought_chunk` and `plan` were never observed live (see module doc) — this fixture is
  // schema-derived, not captured: `entries[].priority` (required by the public ACP schema) and
  // `agent_thought_chunk`'s shape (mirroring the sibling `agent_message_chunk`'s confirmed-live
  // `content`/`messageId` fields, since both are the same producer's message-chunk family) are
  // synthetic. It exercises `mapMessageChunk('reasoning', …)` and `mapPlan` for real rather than
  // leaving them dead code, without claiming a capture that never happened (#443 precedent, B2 review).
  it('maps a schema-derived plan + reasoning turn exactly', () => {
    expect(replay('schema-plan-reasoning', 'session-schema-derived-1')).toStrictEqual(
      expectedEvents('schema-plan-reasoning'),
    );
  });

  it('malformed and unknown session/update payloads are ignored without throwing', () => {
    const state = createJunieUiState();
    for (const value of [null, 42, [], {}, { sessionUpdate: 'future_event' }, { sessionUpdate: 42 }]) {
      const mapped = mapJunieSessionUpdate(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('session.started is idempotent (dedup on the sessionId already seen)', () => {
    const first = junieSessionStarted('s1', createJunieUiState());
    expect(first.events).toEqual([{ type: 'session.started', sessionId: 's1', backend: 'junie' }]);
    const second = junieSessionStarted('s1', first.state);
    expect(second.events).toEqual([]);
  });

  it('closes an open message/reasoning item on turn completion even with no closing frame', () => {
    let state = junieTurnStarted(createJunieUiState()).state;
    state = mapJunieSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'partial' } },
      state,
    ).state;
    const completed = junieTurnCompleted('cancelled', undefined, state);
    expect(completed.events).toEqual([
      { type: 'item.completed', item: { kind: 'message', id: 'm1', role: 'assistant', text: 'partial' } },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' },
    ]);
  });

  it('folds id-less chunks of the same message together, but keeps two SEPARATE id-less messages apart', () => {
    let state = junieTurnStarted(createJunieUiState()).state;
    // Two chunks with no messageId, back to back, with nothing closing the first in between —
    // read as continuations of ONE message (junie sends no per-message id at all for some
    // frames and no separate continuation signal either).
    state = mapJunieSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part one ' } },
      state,
    ).state;
    const secondChunk = mapJunieSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part two' } },
      state,
    );
    expect(secondChunk.events).toEqual([
      { type: 'item.delta', itemId: 'junie-message-no-id-1', field: 'text', delta: 'part two' },
    ]);
    // A tool call closes the first message; a THIRD id-less chunk afterwards starts a brand
    // new item rather than reopening/merging into the first (the bug: a shared per-kind
    // constant made every id-less message compare equal to every other).
    const afterTool = mapJunieSessionUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'in_progress' },
      secondChunk.state,
    );
    const thirdChunk = mapJunieSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unrelated' } },
      afterTool.state,
    );
    expect(thirdChunk.events).toEqual([
      { type: 'item.started', item: { kind: 'message', id: 'junie-message-no-id-2', role: 'assistant', text: '' } },
      { type: 'item.delta', itemId: 'junie-message-no-id-2', field: 'text', delta: 'unrelated' },
    ]);
  });

  it('maps documented ACP stop reasons not yet observed on junie\'s own wire', () => {
    expect(junieStopReason('refusal')).toBe('refusal');
    expect(junieStopReason('max_turn_requests')).toBe('max_tokens');
    expect(junieStopReason('something_new')).toBe('error');
  });

  it('a tool_call with no toolCallId, and a tool_call_update for an unknown id, map to zero events', () => {
    const state = createJunieUiState();
    expect(mapJunieSessionUpdate({ sessionUpdate: 'tool_call', title: 'x', kind: 'other' }, state).events).toEqual([]);
    expect(
      mapJunieSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed' }, state)
        .events,
    ).toEqual([{ type: 'item.completed', item: expect.objectContaining({ id: 'unknown', status: 'completed' }) }]);
  });

  it('an unrecognized tool_call.kind falls back to "other"', () => {
    const mapped = mapJunieSessionUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Mystery', kind: 'teleport', status: 'in_progress' },
      createJunieUiState(),
    );
    expect(mapped.events).toEqual([
      { type: 'item.started', item: expect.objectContaining({ toolKind: 'other', name: 'teleport' }) },
    ]);
  });

  it('a newly created file diff has no oldText key on the wire, mapped to oldText: null', () => {
    const mapped = mapJunieSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Create a.txt',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: '/tmp/a.txt', newText: 'A' }],
      },
      createJunieUiState(),
    );
    expect(mapped.events).toEqual([
      {
        type: 'item.completed',
        item: expect.objectContaining({ diffs: [{ path: '/tmp/a.txt', oldText: null, newText: 'A' }] }),
      },
    ]);
  });
});

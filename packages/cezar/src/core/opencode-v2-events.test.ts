/**
 * `OpencodeV2Translator` — the 2.x → v1 boundary of `OpencodeSession.handleFrame`.
 *
 * Two levels of contract, both pinned here with payloads captured from a live
 * `opencode serve` (probe transcripts in `/tmp/oc_events.json` shape):
 *   1. v1 events as the runner's `handleEvent`/`handlePart` and the UI mapper
 *      consume them — role announced before parts, cumulative text, `time.end`
 *      completion, tool input at first sight, stable usage id, `session.idle`
 *      as the turn boundary;
 *   2. the composed pipeline: translated frames folded through the real
 *      `mapOpencodeEvent` must produce the same UI events a live turn does
 *      (item deltas, tool lifecycle, `turn.completed`).
 *
 * v1 frames (mock server, NDJSON recordings) must pass through untouched.
 */
import { describe, expect, it } from 'vitest';

import {
  createOpencodeUiState,
  mapOpencodeEvent,
  opencodeSessionStarted,
  opencodeTurnStarted,
  type OpencodeUiMapperState,
} from './opencode-ui-mapper.ts';
import { OpencodeV2Translator, type OpencodeEvent } from './opencode-v2-events.ts';
import type { UiEvent } from './ui-events.ts';

const SID = 'ses_f088d18ddffeciJa7FqU52CZLP';
const MSG_TOOL = 'msg_0f772eb2700191WqnUqc9rjyqU';
const MSG_TEXT = 'msg_0f772fc9d0016kw4K2hf08Ps1G';
const CALL = 'call_5f150aa650f149d680d8211f';

/** The captured envelope `{id, created, type, data}`. */
const frame = (type: string, data: Record<string, unknown>, created = 1_790_857_906_000): unknown => ({
  id: `evt_${type}`,
  created,
  type,
  data,
});

const stepStarted = (): unknown =>
  frame('session.step.started', {
    sessionID: SID,
    agent: 'build',
    model: { id: 'mimo-v2.6-flash-free', providerID: 'opencode', variant: 'default' },
    assistantMessageID: MSG_TOOL,
    started: 1_790_857_898_847,
  });

describe('OpencodeV2Translator', () => {
  it('passes v1 frames through untouched (mock server + NDJSON recordings)', () => {
    const t = new OpencodeV2Translator();
    const v1: OpencodeEvent = { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', text: 'x' } } };
    expect(t.translate(v1)).toEqual([v1]);
    expect(t.translate({ type: 'session.idle', properties: { sessionID: 's' } })).toEqual([
      { type: 'session.idle', properties: { sessionID: 's' } },
    ]);
    expect(t.translate({ type: 'server.connected', properties: {} })).toEqual([{ type: 'server.connected', properties: {} }]);
  });

  it('drops what it does not know, and never throws', () => {
    const t = new OpencodeV2Translator();
    expect(t.translate(null)).toEqual([]);
    expect(t.translate({ type: 'session.inbox.enqueued', data: {} })).toEqual([]);
    expect(t.translate({ type: 'server.connected', data: {} })).toEqual([]);
    expect(t.translate({ type: 'agent.updated', data: { id: 'a' } })).toEqual([]);
    expect(t.translate('not an event')).toEqual([]);
  });

  it('announces the assistant role once per message, ahead of its parts', () => {
    const t = new OpencodeV2Translator();
    const out = [
      ...t.translate(stepStarted()),
      ...t.translate(frame('session.text.started', { sessionID: SID, assistantMessageID: MSG_TOOL, ordinal: 0 })),
    ];
    const announces = out.filter((e) => e.type === 'message.updated');
    expect(announces).toHaveLength(1);
    expect(announces[0]?.properties?.info).toMatchObject({ id: MSG_TOOL, role: 'assistant', sessionID: SID });
    // The announce precedes the part in the same batch — both consumers gate
    // parts on the role they learned from it.
    expect(out[0]?.type).toBe('message.updated');
    expect(out[1]?.type).toBe('message.part.updated');
  });

  it('accumulates text deltas into full snapshots and completes with time.end', () => {
    const t = new OpencodeV2Translator();
    const started = t.translate(frame('session.text.started', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0 }, 100));
    const d1 = t.translate(frame('session.text.delta', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0, delta: 'PO' }, 110));
    const d2 = t.translate(frame('session.text.delta', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0, delta: 'NG' }, 120));
    const ended = t.translate(frame('session.text.ended', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0, text: 'PONG' }, 130));

    const part = (batch: OpencodeEvent[]): Record<string, unknown> =>
      (batch.find((e) => e.type === 'message.part.updated')?.properties?.part ?? {}) as Record<string, unknown>;
    expect(part(started)).toMatchObject({ id: `${MSG_TEXT}#0`, messageID: MSG_TEXT, sessionID: SID, type: 'text', text: '' });
    expect(part(d1)).toMatchObject({ text: 'PO' });
    expect(part(d2)).toMatchObject({ text: 'PONG' });
    const finalPart = part(ended);
    expect(finalPart).toMatchObject({ text: 'PONG', time: { start: 100, end: 130 } });
    expect(typeof (finalPart.time as Record<string, number>).end).toBe('number');
  });

  it('translates reasoning the same way, typed `reasoning`', () => {
    const t = new OpencodeV2Translator();
    // First event of this message → the batch leads with the role announce,
    // then the empty part; later batches are parts only.
    const started = t.translate(frame('session.reasoning.started', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0 }));
    expect(started).toHaveLength(2);
    const d = t.translate(frame('session.reasoning.delta', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0, delta: 'hmm' }));
    const part = d[0]?.properties?.part as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'reasoning', text: 'hmm' });
  });

  it('holds tool parts until `called` supplies the input, then tracks pending → running → completed', () => {
    const t = new OpencodeV2Translator();
    // The step announcement claims this message's role first (as live traffic
    // does); from here on a bare input event must emit NOTHING — the runner
    // records the tool call from the first part it sees, so that part has to
    // carry the arguments.
    t.translate(stepStarted());
    expect(t.translate(frame('session.tool.input.started', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, name: 'websearch' }))).toEqual([]);
    expect(
      t.translate(frame('session.tool.input.ended', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, text: '{"query": "Rithmomachia"}' })),
    ).toEqual([]);

    const pending = t.translate(
      frame('session.tool.called', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, input: { query: 'Rithmomachia' }, executed: false }),
    );
    const pendingPart = (pending[0]?.properties?.part ?? {}) as Record<string, unknown>;
    expect(pendingPart).toMatchObject({
      id: CALL,
      callID: CALL,
      messageID: MSG_TOOL,
      sessionID: SID,
      type: 'tool',
      tool: 'websearch',
      state: { status: 'pending', input: { query: 'Rithmomachia' } },
    });

    const running = t.translate(
      frame('session.tool.progress', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, metadata: { provider: 'exa' } }),
    );
    expect(((running[0]?.properties?.part ?? {}) as Record<string, unknown>).state).toMatchObject({
      status: 'running',
      input: { query: 'Rithmomachia' },
      metadata: { provider: 'exa' },
    });

    const done = t.translate(
      frame('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG_TOOL,
        id: CALL,
        content: [{ type: 'text', text: '## Rithmomachia\nAn early board game.' }],
        metadata: { provider: 'exa', truncated: false },
        executed: true,
      }),
    );
    const doneState = (((done[0]?.properties?.part ?? {}) as Record<string, unknown>).state ?? {}) as Record<string, unknown>;
    expect(doneState).toMatchObject({
      status: 'completed',
      input: { query: 'Rithmomachia' },
      output: '## Rithmomachia\nAn early board game.',
      metadata: { provider: 'exa', truncated: false },
    });
    expect(typeof doneState.time).toBe('object');
    expect(typeof (doneState.time as Record<string, number>).end).toBe('number');
  });

  it('closes a tool on `session.tool.failed` (the real v2 name) with its error message', () => {
    const t = new OpencodeV2Translator();
    t.translate(stepStarted());
    t.translate(frame('session.tool.input.started', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, name: 'bash' }));
    t.translate(frame('session.tool.called', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, input: { command: 'exit 1' } }));
    const failed = t.translate(
      frame('session.tool.failed', {
        sessionID: SID,
        assistantMessageID: MSG_TOOL,
        id: CALL,
        error: { message: 'command exited with code 1' },
        content: [{ type: 'text', text: 'boom' }],
        metadata: { exit: 1 },
      }),
    );
    const part = (failed[0]?.properties?.part ?? {}) as Record<string, unknown>;
    const state = (part.state ?? {}) as Record<string, unknown>;
    expect(part).toMatchObject({ id: CALL, callID: CALL, type: 'tool', tool: 'bash' });
    expect(state).toMatchObject({ status: 'error', error: 'command exited with code 1', input: { command: 'exit 1' } });
    // `time.end` is what marks the call finished — without it a failed tool
    // would render as still running forever.
    expect(typeof (state.time as Record<string, number>).end).toBe('number');
  });

  it('reports cumulative session usage under ONE stable id, with tokens and cost intact', () => {
    const t = new OpencodeV2Translator();
    const usage = { sessionID: SID, cost: 0, tokens: { input: 4295, output: 22, reasoning: 33, cache: { read: 1344, write: 0 } } };
    const first = t.translate(frame('session.usage.updated', usage));
    const second = t.translate(frame('session.usage.updated', { ...usage, tokens: { ...usage.tokens, input: 5000 } }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const infoA = first[0]?.properties?.info as Record<string, unknown>;
    const infoB = second[0]?.properties?.info as Record<string, unknown>;
    expect(infoA).toMatchObject({ role: 'assistant', sessionID: SID, cost: 0, tokens: usage.tokens });
    // Same id across updates: the mapper sums per message, so a fresh id per
    // snapshot would double count the session total.
    expect(infoB.id).toBe(infoA.id);
    expect(infoA.id).toContain(SID);
  });

  it('maps execution outcomes to the v1 turn boundary', () => {
    const t = new OpencodeV2Translator();
    expect(t.translate(frame('session.execution.succeeded', { sessionID: SID }))).toEqual([
      { type: 'session.idle', properties: { sessionID: SID } },
    ]);
    expect(t.translate(frame('session.execution.interrupted', { sessionID: SID, reason: 'user' }))).toEqual([
      { type: 'session.idle', properties: { sessionID: SID } },
    ]);
    expect(t.translate(frame('session.execution.failed', { sessionID: SID, error: { type: 'provider.no-route', message: 'Model unavailable' } }))).toEqual([
      { type: 'session.error', properties: { sessionID: SID, error: { type: 'provider.no-route', message: 'Model unavailable' } } },
      { type: 'session.idle', properties: { sessionID: SID } },
    ]);
    // Nothing v1 cares about.
    expect(t.translate(frame('session.execution.started', { sessionID: SID }))).toEqual([]);
  });
});

describe('recorded live turn through the UI mapper', () => {
  /** The real pipeline: 2.x frames → translator → `mapOpencodeEvent`, with the
   *  same session/turn prologue the runner emits. */
  function run(frames: unknown[]): { ui: UiEvent[]; state: OpencodeUiMapperState } {
    const t = new OpencodeV2Translator();
    let state = opencodeSessionStarted(SID, createOpencodeUiState()).state;
    state = opencodeTurnStarted(state).state;
    const ui: UiEvent[] = [];
    for (const f of frames) {
      for (const evt of t.translate(f)) {
        const mapped = mapOpencodeEvent(evt, state);
        state = mapped.state;
        ui.push(...mapped.events);
      }
    }
    return { ui, state };
  }

  it('renders the tool lifecycle, the text part, usage, and completes the turn on execution.succeeded', () => {
    const frames: unknown[] = [
      stepStarted(),
      frame('session.tool.input.started', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, name: 'websearch' }),
      frame('session.tool.input.ended', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, text: '{"query": "Rithmomachia"}' }),
      frame('session.tool.called', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, input: { query: 'Rithmomachia' }, executed: false }),
      frame('session.tool.progress', { sessionID: SID, assistantMessageID: MSG_TOOL, id: CALL, metadata: { provider: 'exa' } }),
      frame('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG_TOOL,
        id: CALL,
        content: [{ type: 'text', text: 'A battle of numbers.' }],
        metadata: { provider: 'exa' },
      }),
      frame('session.text.started', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0 }),
      frame('session.text.delta', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0, delta: 'PONG' }),
      frame('session.text.ended', { sessionID: SID, assistantMessageID: MSG_TEXT, ordinal: 0, text: 'PONG' }),
      frame('session.usage.updated', { sessionID: SID, cost: 0, tokens: { input: 4295, output: 22, reasoning: 33, cache: { read: 1344, write: 0 } } }),
      frame('session.execution.succeeded', { sessionID: SID }),
    ];
    const { ui, state } = run(frames);

    const pending = ui.find((e) => e.type === 'item.started' && e.item.id === CALL);
    expect(pending && 'item' in pending ? pending.item : undefined).toMatchObject({
      kind: 'tool',
      name: 'websearch',
      status: 'pending',
    });
    const completed = ui.filter((e) => e.type === 'item.completed').map((e) => ('item' in e ? e.item.id : ''));
    expect(completed).toContain(CALL);

    expect(ui).toContainEqual({ type: 'item.delta', itemId: `${MSG_TEXT}#0`, field: 'text', delta: 'PONG' });
    expect(ui.at(-1)).toMatchObject({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
    expect(state.currentTurnId).toBeNull();
  });

  it('closes the turn as error on execution.failed', () => {
    const { ui } = run([
      stepStarted(),
      frame('session.execution.failed', { sessionID: SID, error: { type: 'provider.no-route', message: 'Model unavailable: opencode/nope' } }),
    ]);
    expect(ui).toContainEqual({ type: 'session.error', message: 'Model unavailable: opencode/nope', fatal: false });
    expect(ui.at(-1)).toMatchObject({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' });
  });
});

/**
 * Golden tests for the Antigravity stream-json → v2 mapper. Every fixture is a live agy 1.4.0
 * capture with local paths redacted (`__fixtures__/antigravity/README.md`). A fixture replays
 * exactly as `AntigravityRunner` drives the mapper: every stdout line in order, malformed lines
 * skipped, no seeding — agy's own `user_input` step opens each turn.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAntigravityUiState, mapAntigravityMessage, type AntigravityUiState } from './antigravity-ui-mapper.ts';
import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'antigravity');
const SCENARIOS = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.ndjson'))
  .map((file) => file.replace(/\.ndjson$/, ''))
  .sort();

function replay(fixture: string, initial = createAntigravityUiState()): { events: UiEvent[]; v1: AgentEvent[]; state: AntigravityUiState } {
  let state = initial;
  const events: UiEvent[] = [];
  const v1: AgentEvent[] = [];
  for (const line of readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const previous = state;
    const before = JSON.stringify({ ...previous, items: [...previous.items] });
    const mapped = mapAntigravityMessage(frame, state);
    expect(JSON.stringify({ ...previous, items: [...previous.items] })).toBe(before);
    state = mapped.state;
    events.push(...mapped.events);
    v1.push(...mapped.agentEvents);
  }
  return { events, v1, state };
}

const expected = (fixture: string): UiEvent[] =>
  JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8')) as UiEvent[];

describe('Antigravity stream mapping (live agy 1.4.0 captures)', () => {
  it('has a golden expectation for every capture', () => {
    expect(SCENARIOS).toEqual(['bad-model', 'resumed-turn', 'subagent-turn', 'text-turn', 'tool-error', 'tools-turn', 'two-turn-session']);
  });

  it.each(SCENARIOS)('replays %s into its golden UiEvents with immutable state', (fixture) => {
    const { events } = replay(fixture);
    expect(JSON.parse(JSON.stringify(events))).toStrictEqual(expected(fixture));
  });

  it('streams text as deltas in v2 but whole messages in v1', () => {
    const { events, v1 } = replay('tool-error');
    expect(events.filter((e) => e.type === 'item.delta').length).toBeGreaterThan(1);
    const texts = v1.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toContain('the file does not exist');
  });

  it('maps tools onto the cross-backend names and keeps their output and errors', () => {
    const tools = replay('tools-turn').events.flatMap((e) => (e.type === 'item.completed' && e.item.kind === 'tool' ? [e.item] : []));
    expect(tools.map((t) => [t.name, t.toolKind, t.status])).toEqual([
      ['Read', 'read', 'completed'],
      ['Write', 'edit', 'completed'],
      ['Bash', 'execute', 'completed'],
    ]);
    expect(tools[2]!.output).toContain('?? b.txt');
    const failed = replay('tool-error').events.find((e) => e.type === 'item.completed' && e.item.kind === 'tool');
    expect(failed).toMatchObject({ item: { status: 'failed', error: expect.stringContaining('cannot find the file') } });
  });

  it('renders invoke_subagent as one task item naming the spawned role', () => {
    const tasks = replay('subagent-turn').events.flatMap((e) =>
      e.type === 'item.completed' && e.item.kind === 'tool' && e.item.toolKind === 'task' ? [e.item] : [],
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ name: 'Task', title: 'Task: Line Counter', status: 'completed' });
  });

  it('opens a turn per stdin message and counts usage from steps, not the cumulative result', () => {
    const { events, v1, state } = replay('two-turn-session');
    expect(events.filter((e) => e.type === 'turn.started').map((e) => (e as { turnId: string }).turnId)).toEqual(['turn_1', 'turn_2']);
    const completed = events.filter((e) => e.type === 'turn.completed') as Extract<UiEvent, { type: 'turn.completed' }>[];
    expect(completed.map((e) => e.usage?.input)).toEqual([14562, 14637]);
    // The second `result` reports 29199 input tokens for the conversation — the sum, not one turn.
    const usage = events.filter((e) => e.type === 'usage.updated').at(-1) as Extract<UiEvent, { type: 'usage.updated' }>;
    expect(usage.usage.input).toBe(29199);
    expect(state.turnId).toBeNull();
    expect(v1.filter((e) => e.type === 'token-usage').at(-1)).toEqual({ type: 'token-usage', tokensUsed: state.tokensUsed });
  });

  it('does not re-count conversation history on a --conversation resume', () => {
    const { events } = replay('resumed-turn', createAntigravityUiState('cee872c9-0b46-48ac-b957-98677f3cd7db'));
    const completed = events.find((e) => e.type === 'turn.completed') as Extract<UiEvent, { type: 'turn.completed' }>;
    // The resumed result says 75006 input tokens (the whole conversation); this turn used 15467.
    expect(completed.usage?.input).toBe(15467);
  });

  it('falls back to result.usage only on a fresh conversation, never on a resume', () => {
    const result = { event: 'result', result: { status: 'SUCCESS', response: 'hi', usage: { input_tokens: 75006, output_tokens: 10 } } };
    const opened = (state: AntigravityUiState) =>
      mapAntigravityMessage({ event: 'step_update', step_update: { step_index: 1, step_type: 'user_input', state: 'DONE' } }, state).state;
    const fresh = mapAntigravityMessage(result, opened(createAntigravityUiState()));
    expect(fresh.events).toContainEqual(expect.objectContaining({ type: 'usage.updated' }));
    const resumed = mapAntigravityMessage(result, opened(createAntigravityUiState('conv-1')));
    expect(resumed.events.some((e) => e.type === 'usage.updated')).toBe(false);
    expect(resumed.state.tokensUsed).toBe(0);
  });

  it('reports a failed turn as an error stop reason, non-fatal at the mapper level', () => {
    const { events, v1 } = replay('bad-model');
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'session.error', fatal: false }));
    expect(v1).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('bogus-model') }));
  });

  it('ignores malformed and unknown frames', () => {
    const state = createAntigravityUiState();
    for (const value of [null, [], 'noise', 7, { event: 'unknown' }, { event: { toString: null } }]) {
      expect(mapAntigravityMessage(value, state)).toEqual({ state, events: [], agentEvents: [] });
    }
  });

  it('keeps unknown tool names as text even when they match object prototype keys', () => {
    const mapped = mapAntigravityMessage(
      { event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'DONE', tool_name: '__proto__' } },
      createAntigravityUiState(),
    );
    expect(mapped.agentEvents).toContainEqual({ type: 'tool-call', id: 'step_1', tool: '__proto__', input: {} });
  });

  it('closes an unfinished tool as failed when the turn ends under it', () => {
    const opened = mapAntigravityMessage(
      { event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', step_index: 1, tool_name: 'run_command' } },
      createAntigravityUiState(),
    );
    const ended = mapAntigravityMessage({ event: 'result', result: { status: 'ERROR', error: 'denied' } }, opened.state);
    expect(ended.events).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ status: 'failed' }) }));
    expect(ended.agentEvents).toContainEqual(expect.objectContaining({ type: 'tool-result', isError: true }));
    expect(ended.agentEvents).toContainEqual({ type: 'error', message: 'denied' });
  });
});

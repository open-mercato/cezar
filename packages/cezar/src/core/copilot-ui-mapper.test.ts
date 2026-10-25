import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent } from './ui-events.ts';
import {
  COPILOT_AUTH_FAILURE_MESSAGE,
  createCopilotUiState,
  mapCopilotFrame,
  type CopilotUiMapperState,
} from './copilot-ui-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'copilot');

/** Replay a transcript exactly as the runner drives the mapper: every frame, both directions, in
 *  wire order (the header line is metadata, not wire). */
function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: CopilotUiMapperState = createCopilotUiState();
  const events: UiEvent[] = [];
  for (const line of lines) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if ('fixture' in value) continue;
    const mapped = mapCopilotFrame(value, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  // Round-trip: these events get persisted as NDJSON, so a stray `undefined` must fail here.
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.ndjson'))
  .map((file) => file.replace(/\.ndjson$/, ''))
  .sort();

function items(events: UiEvent[]) {
  return events.flatMap((e) =>
    e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed' ? [e.item] : []);
}

describe('copilot --acp → v2 golden fixtures', () => {
  it('has a fixture for every scenario Step 2.3 covers', () => {
    expect(FIXTURE_NAMES).toEqual(['auth-required', 'cancel', 'malformed', 'subagent', 'tool-lifecycle']);
  });

  for (const name of FIXTURE_NAMES) {
    it(`maps ${name} exactly`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')) as UiEvent[];
      expect(replay(name)).toStrictEqual(expected);
    });

    it(`${name}: the header cites the CLI version and the wire source`, () => {
      const header = JSON.parse(readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').split('\n')[0]!) as {
        fixture?: { cli?: string; docs?: string; record?: string };
      };
      expect(header.fixture?.cli).toBe('@github/copilot 1.0.88 (buildMetadata.gitCommit 52f75603)');
      expect(header.fixture?.docs).toContain('agentclientprotocol.com');
      expect(header.fixture?.record).toBe('.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md');
    });
  }

  it('reads a `pending` announcement as a RUNNING tool — Copilot never sends `in_progress`', () => {
    const events = replay('tool-lifecycle');
    const started = events.find((e) => e.type === 'item.started' && e.item.kind === 'tool');
    expect(started && started.type === 'item.started' && started.item.kind === 'tool' && started.item.status)
      .toBe('running');
    // …and a later status still wins, so nothing is stuck running.
    expect(items(events).filter((i) => i.kind === 'tool' && i.status === 'completed')).not.toHaveLength(0);
    expect(items(events).filter((i) => i.kind === 'tool' && i.status === 'failed')).not.toHaveLength(0);
  });

  it('carries Copilot’s native plan channel straight through — no tool side-reading', () => {
    const plans = replay('tool-lifecycle').filter((e) => e.type === 'plan.updated');
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Read calc.py', status: 'in_progress', priority: 'medium' },
        { content: 'Fix add() so it returns a + b', status: 'pending', priority: 'medium' },
        { content: 'Run the checks', status: 'pending', priority: 'medium' },
      ],
    });
  });

  it('reads per-turn usage off the prompt result’s top-level `usage`, directionally', () => {
    const completed = replay('tool-lifecycle').find((e) => e.type === 'turn.completed');
    expect(completed).toMatchObject({
      stopReason: 'end_turn',
      usage: { input: 12045, output: 388, total: 12433, reasoning: 64, cacheRead: 9600, cacheWrite: 120 },
    });
  });

  it('does not map `usage_update` — it is a context gauge, not token counts', () => {
    // `{used, size}` says how full the context window is; mapping it as usage would report the
    // window size as tokens spent. Deliberate: see __fixtures__/copilot/README.md.
    const usage = replay('tool-lifecycle').filter((e) => e.type === 'usage.updated');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ usage: { total: 12433 } });
  });

  it('nests a subagent’s work under the delegating task item', () => {
    const events = replay('subagent');
    const task = items(events).find((i) => i.kind === 'tool' && i.toolKind === 'task');
    expect(task?.id).toBe('call_task_1');
    const child = items(events).find((i) => i.id === 'call_grep_1');
    expect(child?.parentItemId).toBe('call_task_1');
    // The delegation itself is nobody's child.
    expect(task?.parentItemId).toBeUndefined();
  });

  it('settles a tool the cancelled turn left running, instead of spinning forever', () => {
    const events = replay('cancel');
    const bash = items(events).filter((i) => i.id === 'call_bash_1');
    expect(bash.at(-1)).toMatchObject({ status: 'failed' });
    expect(events.filter((e) => e.type === 'turn.completed').map((e) => e.type === 'turn.completed' && e.stopReason))
      .toEqual(['cancelled', 'end_turn']);
  });

  it('turns the unauthenticated `session/new` answer into a fatal session error in cezar’s words', () => {
    expect(replay('auth-required')).toEqual([
      { type: 'session.error', message: COPILOT_AUTH_FAILURE_MESSAGE, fatal: true },
    ]);
  });

  it('renders nothing at all for the malformed and not-yet-mapped frames', () => {
    // Only the turn's own bookends survive: everything between them is unknown, malformed, or a
    // kind cezar does not render.
    expect(replay('malformed').map((e) => e.type)).toEqual(['session.started', 'turn.started', 'usage.updated', 'turn.completed']);
  });

  it('degrades a malformed `_meta` to "no parent" rather than dropping the tool call', () => {
    // A bad `_meta` says nothing about whether the tool ran, so the card must still appear.
    let state = createCopilotUiState();
    state = mapCopilotFrame({ dir: 'out', frame: { jsonrpc: '2.0', id: 0, method: 'session/prompt', params: {} } }, state).state;
    const mapped = mapCopilotFrame(
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'x', status: 'pending', _meta: 'not-an-object' } } } },
      state,
    );
    expect(mapped.events).toHaveLength(1);
    const [started] = mapped.events;
    const item = started?.type === 'item.started' ? started.item : undefined;
    expect(item).toMatchObject({ kind: 'tool', id: 'x', status: 'running' });
    expect(item && 'parentItemId' in item).toBe(false);
  });

  it('ignores malformed and unknown frames without throwing', () => {
    let state = createCopilotUiState();
    state = mapCopilotFrame({ dir: 'out', frame: { jsonrpc: '2.0', id: 0, method: 'session/prompt', params: {} } }, state).state;
    for (const value of [
      null,
      42,
      'text',
      [],
      {},
      { dir: 'sideways', frame: {} },
      { dir: 'in' },
      { dir: 'in', frame: null },
      { dir: 'in', frame: { method: 'session/update' } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'future_kind', x: 1 } } } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: null } } } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: 'nope' } } } },
      { dir: 'in', frame: { id: 12345, result: {} } },
      { dir: 'in', frame: { method: 'some/future_notification', params: {} } },
    ]) {
      const mapped = mapCopilotFrame(value, state);
      expect(mapped.events).toEqual([]);
    }
  });
});

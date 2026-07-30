/**
 * Golden tests for the claude stream-json → v2 mapper: each fixture in
 * `__fixtures__/claude/` is a wire-faithful NDJSON stdout transcript
 * (shapes from `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md`
 * §1 and the dry-run mock `scripts/mock-claude.mjs`); its `.expected.json`
 * is the EXACT `UiEvent` sequence the mapper must produce. Plus edge cases
 * (never-throw, state carry-over) and a live wiring test through the real
 * runner against the bundled mock CLI.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  type ClaudeUiMapperState,
  type ClaudeUiMapping,
} from './claude-ui-mapper.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'claude');

/** Replay a fixture exactly as the runner drives the mapper: the seed user
 *  message is sent (turn start) BEFORE the first stdout line is read, and
 *  unparseable lines are skipped. */
function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createClaudeUiState();
  const events: UiEvent[] = [];
  const push = (mapped: ClaudeUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(claudeTurnStarted(state));
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // mirrors the runner: malformed lines are skipped
    }
    push(mapClaudeMessage(msg, state));
  }
  return events;
}

function expectedEvents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
}

const GOLDEN_FIXTURES = [
  'text-turn',
  'bash-and-screenshot',
  'thinking-edit-write-todo',
  'subagent-task',
  'failed-and-denied',
  // Wire shapes transcribed from a real `claude --output-format stream-json`
  // capture (CLI 2.1.211) — the task tools' result text is the mapper's only
  // source for task ids, so it is pinned here verbatim.
  'task-tools-plan',
] as const;

describe('claude → v2 golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      // Round-trip through JSON so stray `undefined` properties fail loudly —
      // these events get persisted as NDJSON in step 2.1.
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(expectedEvents(fixture));
    });
  }
});

describe('mapClaudeMessage edge cases', () => {
  const state = createClaudeUiState();

  it('non-object and unknown message types produce no events and never throw', () => {
    for (const msg of [null, undefined, 42, 'assistant', [], {}, { type: 'stream_event', event: {} }, { type: 'control_request' }]) {
      const mapped = mapClaudeMessage(msg, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('unknown content block types inside an assistant message are ignored', () => {
    const mapped = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'x' },
            'not-a-block',
            { type: 'tool_use' }, // missing id/name → skipped
            { type: 'text', text: 'still works' },
          ],
        },
      },
      state,
    );
    expect(mapped.events.map((e) => e.type)).toEqual(['item.started', 'item.completed']);
  });

  it('malformed message envelopes (content not an array, message missing) are safe', () => {
    expect(mapClaudeMessage({ type: 'assistant', message: { content: 'oops' } }, state).events).toEqual([]);
    expect(mapClaudeMessage({ type: 'assistant' }, state).events).toEqual([]);
    expect(mapClaudeMessage({ type: 'user', message: { content: [{ type: 'tool_result' }] } }, state).events).toEqual([]);
  });

  it('state carries across messages: a tool opened earlier is completed by a later result', () => {
    let s = createClaudeUiState();
    s = mapClaudeMessage({ type: 'system', subtype: 'init', session_id: 's1' }, s).state;
    const start = mapClaudeMessage(
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] },
      },
      s,
    );
    s = start.state;
    // An unrelated message in between must not disturb the open tool.
    s = mapClaudeMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hm' }] } }, s).state;
    const done = mapClaudeMessage(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'a b c' }] } },
      s,
    );
    expect(done.events).toEqual([
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: 'toolu_x',
          name: 'Bash',
          toolKind: 'execute',
          title: 'Ran ls',
          status: 'completed',
          input: { command: 'ls' },
          output: 'a b c',
        },
      },
    ]);
    // The open-tool map is consumed…
    expect(done.state.openTools.has('toolu_x')).toBe(false);
    // …without mutating the previous state (explicit-state contract).
    expect(s.openTools.has('toolu_x')).toBe(true);
  });

  it('a tool_result for an id that never started still completes an item', () => {
    const mapped = mapClaudeMessage(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: 'late', is_error: true }] } },
      state,
    );
    expect(mapped.events).toEqual([
      {
        type: 'item.completed',
        item: { kind: 'tool', id: 'toolu_ghost', name: 'unknown', toolKind: 'other', title: 'Tool', status: 'failed', error: 'late' },
      },
    ]);
  });

  it('maps result subtypes onto stop reasons per §7.1', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'result', subtype: 'success' }, 'end_turn'],
      [{ type: 'result', subtype: 'error_max_turns', is_error: true }, 'max_tokens'],
      [{ type: 'result', subtype: 'error_during_execution', is_error: true }, 'error'],
      [{ type: 'result', subtype: 'something_new', is_error: true }, 'error'],
      [{ type: 'result' }, 'end_turn'],
    ];
    for (const [msg, stopReason] of cases) {
      const [event] = mapClaudeMessage(msg, state).events;
      expect(event).toMatchObject({ type: 'turn.completed', stopReason });
    }
  });

  it('result without usage emits turn.completed but no usage.updated', () => {
    const mapped = mapClaudeMessage({ type: 'result', subtype: 'success' }, state);
    expect(mapped.events.map((e) => e.type)).toEqual(['turn.completed']);
  });

  // The runner emits a v1 `text` from `msg.result` when a session streamed no assistant text
  // block (claude-cli-runner.ts, `textChunks.length === 0`). Without the v2 twin, that prose
  // reached the cockpit only in v1 — where the thread reducer's per-turn "v2 wins" rule deleted
  // it as soon as any tool item landed, so the message appeared and then vanished.
  it('mints a message item from msg.result when the session streamed no text block', () => {
    const mapped = mapClaudeMessage({ type: 'result', subtype: 'success', result: 'The whole reply.' }, state);
    expect(mapped.events).toEqual([
      { type: 'item.started', item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'The whole reply.' } },
      { type: 'item.completed', item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'The whole reply.' } },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
  });

  it('does NOT mint a result message once a text block already streamed — no duplicate prose', () => {
    const streamed = mapClaudeMessage(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Streamed.' }] } },
      state,
    );
    const mapped = mapClaudeMessage({ type: 'result', subtype: 'success', result: 'Streamed.' }, streamed.state);
    expect(mapped.events.map((e) => e.type)).toEqual(['turn.completed']);
  });

  it('the no-text-block guard is session-scoped, mirroring the runner s textChunks', () => {
    // textChunks is allocated once per runAgent and never cleared, so a later turn that streams
    // nothing gets NO v1 result fallback — and must get no v2 twin either.
    const streamed = mapClaudeMessage(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Turn one.' }] } },
      state,
    );
    const firstResult = mapClaudeMessage({ type: 'result', subtype: 'success', result: 'Turn one.' }, streamed.state);
    const nextTurn = claudeTurnStarted(firstResult.state);
    const mapped = mapClaudeMessage({ type: 'result', subtype: 'success', result: 'Turn two.' }, nextTurn.state);
    expect(mapped.events.map((e) => e.type)).toEqual(['turn.completed']);
  });

  it('an empty result string mints nothing', () => {
    const mapped = mapClaudeMessage({ type: 'result', subtype: 'success', result: '' }, state);
    expect(mapped.events.map((e) => e.type)).toEqual(['turn.completed']);
  });

  it('TodoWrite with malformed todos filters bad entries; non-array todos emit no plan', () => {
    const good = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_t',
              name: 'TodoWrite',
              input: { todos: [{ content: 'ok', status: 'pending' }, { content: 'bad status', status: 'later' }, { status: 'pending' }, 'junk'] },
            },
          ],
        },
      },
      state,
    );
    expect(good.events.at(-1)).toEqual({ type: 'plan.updated', entries: [{ content: 'ok', status: 'pending' }] });

    const bad = mapClaudeMessage(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_t2', name: 'TodoWrite', input: { todos: 'nope' } }] } },
      state,
    );
    expect(bad.events.map((e) => e.type)).toEqual(['item.started']);
  });

  // Task-tool wire shapes below are transcribed from a real `claude
  // --output-format stream-json` capture (CLI 2.1.211): a create answers
  // `Task #1 created successfully: <subject>`, an update `Updated task #1
  // status`, and TaskList `#1 [in_progress] One` per line. A rejected update
  // answers `Task not found` with `is_error` UNSET, so result text — not
  // `is_error` — is the only outcome signal the task tools give.
  const taskUse = (id: string, name: string, input: unknown, parentToolUseId?: string) => ({
    type: 'assistant' as const,
    ...(parentToolUseId === undefined ? {} : { parent_tool_use_id: parentToolUseId }),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const taskResult = (toolUseId: string, content: string, isError?: true) => ({
    type: 'user' as const,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError === undefined ? {} : { is_error: isError }) },
      ],
    },
  });
  /** Create a task and land its harness-assigned id, as the real wire does. */
  const create = (
    state: ClaudeUiMapperState,
    toolUseId: string,
    subject: string,
    id: string,
    extra: Record<string, unknown> = {},
  ) => {
    const used = mapClaudeMessage(taskUse(toolUseId, 'TaskCreate', { subject, description: 'd', ...extra }), state);
    return mapClaudeMessage(taskResult(toolUseId, `Task #${id} created successfully: ${subject}`), used.state);
  };

  it('builds a plan incrementally, keying tasks by the id the TaskCreate result reports', () => {
    let state = createClaudeUiState();

    // The id is only knowable from the result, so the create itself renders
    // nothing — the plan lands when the harness answers.
    const used = mapClaudeMessage(
      taskUse('toolu_c1', 'TaskCreate', { subject: 'Wire the dock', activeForm: 'Wiring the dock' }),
      state,
    );
    expect(used.events.map((event) => event.type)).toEqual(['item.started']);
    const landed = mapClaudeMessage(taskResult('toolu_c1', 'Task #1 created successfully: Wire the dock'), used.state);
    state = landed.state;
    expect(landed.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'Wire the dock', status: 'pending', activeForm: 'Wiring the dock' }],
    });

    const second = create(state, 'toolu_c2', 'Add tests', '2');
    state = second.state;
    expect(second.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Wire the dock', status: 'pending', activeForm: 'Wiring the dock' },
        { content: 'Add tests', status: 'pending' },
      ],
    });

    // An update carries the harness's own taskId, so it applies at call time.
    const update = mapClaudeMessage(taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }), state);
    state = update.state;
    expect(update.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Wire the dock', status: 'in_progress', activeForm: 'Wiring the dock' },
        { content: 'Add tests', status: 'pending' },
      ],
    });

    // A numeric taskId is coerced, so the update still lands on task 2.
    const numeric = mapClaudeMessage(taskUse('toolu_u2', 'TaskUpdate', { taskId: 2, status: 'completed' }), state);
    state = numeric.state;
    expect(numeric.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Wire the dock', status: 'in_progress', activeForm: 'Wiring the dock' },
        { content: 'Add tests', status: 'completed' },
      ],
    });

    const unknown = mapClaudeMessage(taskUse('toolu_u3', 'TaskUpdate', { taskId: '9', status: 'completed' }), state);
    expect(unknown.events.map((event) => event.type)).toEqual(['item.started']);
    const unchanged = mapClaudeMessage(taskUse('toolu_u4', 'TaskUpdate', { taskId: '2', status: 'completed' }), state);
    expect(unchanged.events.map((event) => event.type)).toEqual(['item.started']);
  });

  it('honors the harness id even when it does not match the number of creates', () => {
    // A resumed session (`claude --resume`) reopens a conversation whose task
    // list is already at 1..N while this mapper starts empty, so the id of the
    // first create it sees is NOT '1'. Counting creates would file this task
    // under '1' and then land task 3's updates on it — a confidently wrong plan
    // in the dock, which is worse than an empty one. The id comes off the wire.
    let state = createClaudeUiState();
    const resumedUpdate = mapClaudeMessage(taskUse('toolu_u0', 'TaskUpdate', { taskId: '1', status: 'in_progress' }), state);
    // Task 1 belongs to the pre-resume session: unknown here, so it is dropped
    // rather than applied to whatever this mapper happens to hold.
    expect(resumedUpdate.events.map((event) => event.type)).toEqual(['item.started']);
    state = resumedUpdate.state;

    const created = create(state, 'toolu_c1', 'New task', '3');
    state = created.state;
    expect(created.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'New task', status: 'pending' }],
    });

    // The id the mapper would have guessed ('1') must not touch the new task…
    expect(
      mapClaudeMessage(taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'completed' }), state).events.map(
        (event) => event.type,
      ),
    ).toEqual(['item.started']);
    // …and the real one must.
    const real = mapClaudeMessage(taskUse('toolu_u2', 'TaskUpdate', { taskId: '3', status: 'completed' }), state);
    expect(real.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'New task', status: 'completed' }],
    });
  });

  it('recovers a resumed session\'s pre-existing tasks from a TaskList result', () => {
    let state = createClaudeUiState();
    // TaskList is the only message carrying the whole list, so it is how tasks
    // created before this mapper existed reach the dock at all.
    const used = mapClaudeMessage(taskUse('toolu_l1', 'TaskList', {}), state);
    const listed = mapClaudeMessage(
      taskResult('toolu_l1', '#1 [in_progress] Alpha\n#2 [completed] Beta\n#4 [pending] Gamma'),
      used.state,
    );
    state = listed.state;
    expect(listed.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Alpha', status: 'in_progress' },
        { content: 'Beta', status: 'completed' },
        // Gap at #3 (deleted before the resume): ids are the harness's, not a
        // dense index, so the mapper must key on them verbatim.
        { content: 'Gamma', status: 'pending' },
      ],
    });

    // Recovered ids are real ids: updates against them now land.
    const update = mapClaudeMessage(taskUse('toolu_u1', 'TaskUpdate', { taskId: '4', status: 'completed' }), state);
    expect(update.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Alpha', status: 'in_progress' },
        { content: 'Beta', status: 'completed' },
        { content: 'Gamma', status: 'completed' },
      ],
    });
  });

  it('keeps activeForm across a TaskList resync and stays silent when nothing changed', () => {
    let state = createClaudeUiState();
    state = create(state, 'toolu_c1', 'One', '1', { activeForm: 'Oneing' }).state;

    // TaskList omits activeForm, so a resync must not blank the dock's label.
    const used = mapClaudeMessage(taskUse('toolu_l1', 'TaskList', {}), state);
    const resync = mapClaudeMessage(taskResult('toolu_l1', '#1 [pending] One'), used.state);
    // Nothing changed, so the resync is pure churn and must not re-emit.
    expect(resync.events.map((event) => event.type)).toEqual(['item.completed']);
    state = resync.state;

    const moved = mapClaudeMessage(taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }), state);
    expect(moved.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'One', status: 'in_progress', activeForm: 'Oneing' }],
    });
  });

  it('ignores an unparsable TaskList rather than dropping live rows', () => {
    let state = createClaudeUiState();
    state = create(state, 'toolu_c1', 'Real task', '1').state;
    const used = mapClaudeMessage(taskUse('toolu_l1', 'TaskList', {}), state);

    // A wording change ("No tasks yet", a header line, …) must leave the known
    // plan alone: a half-parsed list would silently delete rows that still exist.
    for (const body of ['No tasks yet', 'Tasks:\n#1 [pending] Real task', '#1 (pending) Real task']) {
      const listed = mapClaudeMessage(taskResult('toolu_l1', body), used.state);
      expect(listed.events.map((event) => event.type)).toEqual(['item.completed']);
      expect(listed.state.tasks.get('1')).toEqual({ content: 'Real task', status: 'pending' });
    }
    // An errored TaskList is likewise inert.
    const errored = mapClaudeMessage(taskResult('toolu_l1', '#1 [pending] Other', true), used.state);
    expect(errored.events.map((event) => event.type)).toEqual(['item.completed']);
  });

  it('drops a create whose result does not confirm it, minting no id for it', () => {
    let state = createClaudeUiState();
    // A create that was denied/failed never becomes a task. Nothing downstream
    // shifts, because no id was invented for it in the first place.
    const denied = mapClaudeMessage(taskUse('toolu_c1', 'TaskCreate', { subject: 'Never created' }), state);
    const refused = mapClaudeMessage(taskResult('toolu_c1', 'Error: permission denied', true), denied.state);
    expect(refused.events.map((event) => event.type)).toEqual(['item.completed']);
    expect(refused.state.tasks.size).toBe(0);
    expect(refused.state.pendingTaskCreates.size).toBe(0);

    // Same for a success-shaped result the mapper cannot read an id out of.
    const odd = mapClaudeMessage(taskUse('toolu_c2', 'TaskCreate', { subject: 'Unreadable' }), state);
    const unreadable = mapClaudeMessage(taskResult('toolu_c2', 'Task created successfully'), odd.state);
    expect(unreadable.events.map((event) => event.type)).toEqual(['item.completed']);
    expect(unreadable.state.tasks.size).toBe(0);

    // The next real create still lands under the id the harness gives it.
    state = create(state, 'toolu_c3', 'Real', '1').state;
    expect([...state.tasks.keys()]).toEqual(['1']);
  });

  it('ignores task tools called by a subagent', () => {
    // A subagent's tool list has no task tools at all (verified against the live
    // harness), and if that ever changes its ids are its own — folding them in
    // would corrupt the main agent's id space.
    let state = createClaudeUiState();
    state = create(state, 'toolu_c1', 'Main task', '1').state;

    const sub = mapClaudeMessage(taskUse('toolu_c2', 'TaskCreate', { subject: 'Sub task' }, 'toolu_agent'), state);
    expect(sub.events.map((event) => event.type)).toEqual(['item.started']);
    expect(sub.state.pendingTaskCreates.size).toBe(0);
    const subResult = mapClaudeMessage(taskResult('toolu_c2', 'Task #1 created successfully: Sub task'), sub.state);
    expect(subResult.events.map((event) => event.type)).toEqual(['item.completed']);
    expect([...subResult.state.tasks.values()]).toEqual([{ content: 'Main task', status: 'pending' }]);

    // A subagent's TaskList describes ITS tasks, so it must not resync the main
    // plan either — the result side needs the same guard as the call side.
    const subList = mapClaudeMessage(taskUse('toolu_l1', 'TaskList', {}, 'toolu_agent'), state);
    const subListed = mapClaudeMessage(taskResult('toolu_l1', '#1 [completed] Sub task'), subList.state);
    expect(subListed.events.map((event) => event.type)).toEqual(['item.completed']);
    expect([...subListed.state.tasks.values()]).toEqual([{ content: 'Main task', status: 'pending' }]);

    // A subagent's TaskUpdate must not move a main-agent row.
    const subUpdate = mapClaudeMessage(
      taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'toolu_agent'),
      state,
    );
    expect(subUpdate.events.map((event) => event.type)).toEqual(['item.started']);
    expect([...subUpdate.state.tasks.values()]).toEqual([{ content: 'Main task', status: 'pending' }]);
  });

  it('tolerates `running` as an alias for in_progress, though the schema has no such status', () => {
    const state = create(createClaudeUiState(), 'toolu_c1', 'A', '1').state;
    const mapped = mapClaudeMessage(taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'running' }), state);
    expect(mapped.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'A', status: 'in_progress' }],
    });
  });

  it('drops a task TaskUpdate deletes, and leaves the surviving ids alone', () => {
    let state = createClaudeUiState();
    state = create(state, 'toolu_c1', 'Task A', '1').state;
    state = create(state, 'toolu_c2', 'Task B', '2').state;

    // `deleted` is a real TaskUpdate status: it removes the task outright.
    const deleted = mapClaudeMessage(taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', status: 'deleted' }), state);
    state = deleted.state;
    expect(deleted.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'Task B', status: 'pending' }],
    });

    // The harness does not renumber after a delete — Task B stays '2' and the
    // next create is '3'.
    state = create(state, 'toolu_c3', 'Task C', '3').state;
    const progressed = mapClaudeMessage(taskUse('toolu_u2', 'TaskUpdate', { taskId: '3', status: 'completed' }), state);
    state = progressed.state;
    expect(progressed.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Task B', status: 'pending' },
        { content: 'Task C', status: 'completed' },
      ],
    });

    // Deleting an unknown id changes nothing; deleting the rest empties the plan.
    expect(
      mapClaudeMessage(taskUse('toolu_u3', 'TaskUpdate', { taskId: '1', status: 'deleted' }), state).events.map(
        (event) => event.type,
      ),
    ).toEqual(['item.started']);
    state = mapClaudeMessage(taskUse('toolu_u4', 'TaskUpdate', { taskId: '2', status: 'deleted' }), state).state;
    const emptied = mapClaudeMessage(taskUse('toolu_u5', 'TaskUpdate', { taskId: '3', status: 'deleted' }), state);
    expect(emptied.events.at(-1)).toEqual({ type: 'plan.updated', entries: [] });
  });

  it('applies TaskUpdate subject and activeForm edits, and trims the subject', () => {
    let state = createClaudeUiState();
    const created = create(state, 'toolu_c1', '  Old name  ', '1');
    state = created.state;
    expect(created.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'Old name', status: 'pending' }],
    });

    const renamed = mapClaudeMessage(
      taskUse('toolu_u1', 'TaskUpdate', { taskId: '1', subject: 'New name', activeForm: 'Doing the new thing' }),
      state,
    );
    state = renamed.state;
    expect(renamed.events.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [{ content: 'New name', status: 'pending', activeForm: 'Doing the new thing' }],
    });

    // A metadata-only update that changes nothing we render stays silent.
    const noop = mapClaudeMessage(taskUse('toolu_u2', 'TaskUpdate', { taskId: '1', owner: 'someone' }), state);
    expect(noop.events.map((event) => event.type)).toEqual(['item.started']);
  });

  it('ignores a TaskCreate with no usable subject, even once its result lands', () => {
    let state = createClaudeUiState();
    for (const input of [{ description: 'no subject' }, { subject: '   ', description: 'd' }]) {
      const used = mapClaudeMessage(taskUse('toolu_c0', 'TaskCreate', input), state);
      expect(used.events.map((event) => event.type)).toEqual(['item.started']);
      // The harness still mints an id for a blank subject, but with ids read off
      // the wire that no longer offsets anything — the row is simply not shown.
      const landed = mapClaudeMessage(taskResult('toolu_c0', 'Task #1 created successfully:   '), used.state);
      expect(landed.events.map((event) => event.type)).toEqual(['item.completed']);
      expect(landed.state.tasks.size).toBe(0);
    }
  });

  it('init without session_id falls back to the state fallback (dry-run mock shape)', () => {
    const s = createClaudeUiState({ fallbackSessionId: 'spec-session' });
    const [event] = mapClaudeMessage({ type: 'system', subtype: 'init' }, s).events;
    expect(event).toEqual({ type: 'session.started', sessionId: 'spec-session', backend: 'claude' });
  });

  it('turn.started minted before init is flushed right after session.started', () => {
    let s = createClaudeUiState();
    const first = claudeTurnStarted(s);
    expect(first.events).toEqual([]); // queued — session.started must be first
    s = first.state;
    const init = mapClaudeMessage({ type: 'system', subtype: 'init', session_id: 's1' }, s);
    expect(init.events.map((e) => e.type)).toEqual(['session.started', 'turn.started']);
    s = init.state;
    const second = claudeTurnStarted(s);
    expect(second.events).toEqual([{ type: 'turn.started', turnId: 'turn_2' }]);
  });
});

describe('ClaudeCliRunner v2 wiring (against the bundled mock CLI)', () => {
  const mockBin = join(HERE, '..', '..', 'scripts', 'mock-claude.mjs');

  it('preserves an is_error result message as an authoritative v1 error signal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cez-claude-auth-error-'));
    try {
      const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
      const v1: AgentEvent[] = [];
      const session = runner.startSession(
        { userPrompt: 'mock:auth-error', cwd, sessionId: 'sess-auth-error' },
        (event) => v1.push(event),
        { autoEndAfterFirstTurn: true },
      );

      await session.result;

      expect(v1).toContainEqual({
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('emits v2 events through opts.onUiEvent while v1 events keep flowing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cez-ui-mapper-'));
    try {
      const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
      const v1: AgentEvent[] = [];
      const v2: UiEvent[] = [];
      const session = runner.startSession(
        { userPrompt: 'fix the login redirect', cwd, sessionId: 'sess-mock-1' },
        (e) => v1.push(e),
        { autoEndAfterFirstTurn: true, onUiEvent: (e) => v2.push(e) },
      );
      await session.result;

      // v1 stays intact (old NDJSON recordings must keep replaying).
      const v1Types = v1.map((e) => e.type);
      expect(v1Types).toContain('text');
      expect(v1Types).toContain('tool-call');
      expect(v1Types).toContain('tool-result');
      expect(v1Types).toContain('turn-end');
      expect(v1Types).toContain('done');

      // v2 rides alongside: session.started first (mock init has no
      // session_id → spec.sessionId fallback), then the queued turn.started.
      expect(v2[0]).toEqual({ type: 'session.started', sessionId: 'sess-mock-1', backend: 'claude' });
      expect(v2[1]).toEqual({ type: 'turn.started', turnId: 'turn_1' });
      const bashStart = v2.find(
        (e): e is Extract<UiEvent, { type: 'item.started' }> =>
          e.type === 'item.started' && e.item.kind === 'tool' && e.item.name === 'Bash',
      );
      expect(bashStart?.item).toMatchObject({ toolKind: 'execute', title: 'Ran git status --short', status: 'running' });
      const bashDone = v2.find(
        (e): e is Extract<UiEvent, { type: 'item.completed' }> =>
          e.type === 'item.completed' && e.item.kind === 'tool' && e.item.name === 'Bash',
      );
      expect(bashDone?.item).toMatchObject({ status: 'completed', output: ' M src/example.ts' });
      expect(v2.some((e) => e.type === 'image' && e.itemId !== undefined)).toBe(true);
      const turnDone = v2.find((e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
      expect(turnDone).toMatchObject({
        turnId: 'turn_1',
        stopReason: 'end_turn',
        usage: { input: 1270, output: 185, total: 1455 },
        costUsd: 0.0342,
      });
      expect(v2.at(-1)?.type).toBe('usage.updated');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  // The `mock:subagents` trigger is the dry-run testability hook for the Agents
  // dock (spec `.ai/specs/2026-07-20-grouped-subagent-display.md`, #474): without
  // it the dock is unreachable offline, so QA, screenshots and the e2e smoke all
  // depend on this wire shape staying correct.
  it('mock:subagents fans out two parented Task agents', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cez-ui-mapper-sub-'));
    try {
      const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
      const v2: UiEvent[] = [];
      const session = runner.startSession(
        { userPrompt: 'mock:subagents', cwd, sessionId: 'sess-mock-sub' },
        () => {},
        { autoEndAfterFirstTurn: true, onUiEvent: (e) => v2.push(e) },
      );
      await session.result;

      const started = v2.filter(
        (e): e is Extract<UiEvent, { type: 'item.started' }> => e.type === 'item.started',
      );
      // Exactly two parent-less task items — the dock's two rows, and the "N/2" denominator.
      const spawns = started.filter(
        (e) => e.item.kind === 'tool' && e.item.toolKind === 'task' && e.item.parentItemId === undefined,
      );
      expect(spawns).toHaveLength(2);
      expect(spawns.map((e) => e.item.kind === 'tool' && e.item.title)).toEqual([
        'Task: Audit the auth flow',
        'Task: Review the store layer',
      ]);
      // `subagent_type` reaches the item input — the row's type badge reads it.
      expect(spawns[0]!.item).toMatchObject({ input: { subagent_type: 'general-purpose' } });
      expect(spawns[1]!.item).toMatchObject({ input: { subagent_type: 'code-reviewer' } });

      // Every agent owns children, attributed via parentItemId — no orphans.
      const parentIds = new Set(spawns.map((e) => e.item.id));
      for (const parentId of parentIds) {
        const children = started.filter((e) => e.item.parentItemId === parentId);
        expect(children.length).toBeGreaterThan(0);
      }
      // Both spawns settle, so a finished run docks them as completed.
      const completedSpawns = v2.filter(
        (e) => e.type === 'item.completed' && e.item.kind === 'tool' && parentIds.has(e.item.id),
      );
      expect(completedSpawns).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * #528 — a blank `thinking` block carries no information; minting an item for
 * it only produces a dead "Thinking —" row in the session view.
 */
describe('claude blank thinking blocks (#528)', () => {
  function reasoningItems(msg: unknown): UiEvent[] {
    const mapped = mapClaudeMessage(msg, createClaudeUiState());
    return mapped.events.filter((e) => 'item' in e && e.item.kind === 'reasoning');
  }

  function assistant(thinking: string): unknown {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
    };
  }

  it.each([['', 'empty'], ['   ', 'spaces'], ['\n\t ', 'whitespace']])(
    'mints no reasoning item for a %s thinking block (%s)',
    (thinking) => {
      expect(reasoningItems(assistant(thinking))).toEqual([]);
    },
  );

  it('still mints an item for real thinking text', () => {
    const events = reasoningItems(assistant('Checking the auth path.'));
    expect(events).toHaveLength(2); // started + completed
    expect(events.every((e) => 'item' in e && e.item.kind === 'reasoning' && e.item.text === 'Checking the auth path.')).toBe(true);
  });
});

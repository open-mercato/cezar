import { describe, expect, it } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'
import type { UiMessageItem, UiToolItem } from '@open-mercato/cezar-api-client'

import bashAndScreenshot from '../../../../cezar/src/core/__fixtures__/claude/bash-and-screenshot.expected.json'
import failedAndDenied from '../../../../cezar/src/core/__fixtures__/claude/failed-and-denied.expected.json'
import textTurn from '../../../../cezar/src/core/__fixtures__/claude/text-turn.expected.json'
import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import {
  latestPlanEntries,
  reduceThread,
  threadFilePaths,
  threadFooter,
  type ThreadEntry,
} from './thread-state'

/**
 * The reducer, table-driven against REAL event sequences:
 *  - the golden claude fixtures (`src/core/__fixtures__/claude/*.expected.json`) — the exact v2
 *    streams the R2 mappers are pinned to;
 *  - verbatim lines from actual NDJSON transcripts (a pre-v2 run and an R2 dry-run mixed file),
 *    because the v1 fallback and the mixed-file dedup rule are claims about what is really on
 *    disk, not about invented shapes.
 */

/** Golden fixtures are `UiEvent[]` — stamp the wire's seq/ts on them, as the store does. */
const asRunEvents = (events: object[]): RunEvent[] =>
  events.map((event, index) => ({ seq: index + 1, ts: '2026-07-14T12:00:00.000Z', ...event }) as RunEvent)

/** One stamped v1/v2 line, for hand-built sequences. */
const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: '2026-07-14T12:00:00.000Z', type, ...rest }) as RunEvent

const kinds = (items: ThreadEntry[]) => items.map((item) => item.kind)

describe('reduceThread — golden v2 fixtures', () => {
  it('text-turn: one turn, one assistant message, completion recorded', () => {
    const { turns, sessionEnded } = reduceThread(asRunEvents(textTurn))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnId).toBe('turn_1')
    expect(kinds(turns[0]!.items)).toEqual(['message'])
    const message = turns[0]!.items[0] as UiMessageItem
    expect(message.role).toBe('assistant')
    expect(message.text).toBe("I'll fix the bug.")
    expect(turns[0]!.completed).toEqual({ stopReason: 'end_turn', costUsd: 0.0021 })
    expect(turns[0]!.userMessage).toBeUndefined() // the initial prompt is the run's task, not an event
    expect(sessionEnded).toBeUndefined()
  })

  it('thinking-edit-write-todo: reasoning + message + tools in order, plan snapshot on the turn', () => {
    const { turns } = reduceThread(asRunEvents(thinkingEditWriteTodo))
    expect(turns).toHaveLength(1)
    expect(kinds(turns[0]!.items)).toEqual(['reasoning', 'message', 'tool', 'tool', 'tool'])
    const [edit, write, todo] = turns[0]!.items.filter((i): i is UiToolItem => i.kind === 'tool')
    expect(edit!.title).toBe('Edit /repo/src/middleware.ts')
    expect(edit!.status).toBe('completed')
    expect(write!.diffs?.[0]?.oldText).toBeNull() // new file
    expect(todo!.toolKind).toBe('plan')
    expect(turns[0]!.planEntries).toHaveLength(3)
    expect(turns[0]!.planEntries?.[0]).toMatchObject({ status: 'completed' })
  })

  it('bash-and-screenshot: started→completed folds to ONE item per id; base64 v2 image is not rendered', () => {
    const { turns } = reduceThread(asRunEvents(bashAndScreenshot))
    expect(turns).toHaveLength(1)
    // 2 messages + 2 tools — and NO image entry: the v2 `image` event carries raw base64 with
    // no served URL, so there is nothing honest to render from it.
    expect(kinds(turns[0]!.items)).toEqual(['message', 'tool', 'tool', 'message'])
    const bash = turns[0]!.items[1] as UiToolItem
    expect(bash.status).toBe('completed')
    expect(bash.output).toContain('src/example.ts')
  })

  it('failed-and-denied: failed status survives; a completed-without-started item still lands', () => {
    const { turns } = reduceThread(asRunEvents(failedAndDenied))
    const tools = turns[0]!.items.filter((i): i is UiToolItem => i.kind === 'tool')
    expect(tools.map((t) => t.status)).toEqual(['failed', 'declined'])
    expect(tools[0]!.error).toBeTruthy()
  })
})

describe('reduceThread — item ids across workflow steps', () => {
  it('keeps earlier reasoning when a resumed step restarts its item ids', () => {
    const { turns } = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1', stepId: 'initial' }),
      line(2, 'item.started', {
        item: { kind: 'reasoning', id: 'item_1', text: 'Earlier thinking survives.' },
        stepId: 'initial',
      }),
      line(3, 'item.completed', {
        item: { kind: 'reasoning', id: 'item_1', text: 'Earlier thinking survives.' },
        stepId: 'initial',
      }),
      line(4, 'turn.completed', { turnId: 'turn_1', stopReason: 'end_turn', stepId: 'initial' }),
      line(5, 'turn.started', { turnId: 'turn_1', stepId: 'resume' }),
      line(6, 'item.started', {
        item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'Resumed response.' },
        stepId: 'resume',
      }),
      line(7, 'item.completed', {
        item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'Resumed response.' },
        stepId: 'resume',
      }),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]!.items).toEqual([
      { kind: 'reasoning', id: 'item_1', text: 'Earlier thinking survives.' },
    ])
    expect(turns[1]!.items).toEqual([
      { kind: 'message', id: 'item_1', role: 'assistant', text: 'Resumed response.' },
    ])
  })

  it('retains bare-id lifecycle updates for legacy events without stepId', () => {
    const { turns } = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', {
        item: { kind: 'message', id: 'item_1', role: 'assistant', text: '' },
      }),
      line(3, 'item.delta', { itemId: 'item_1', field: 'text', delta: 'Legacy response.' }),
      line(4, 'item.completed', {
        item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'Legacy response.' },
      }),
    ])

    expect(turns[0]!.items).toEqual([
      { kind: 'message', id: 'item_1', role: 'assistant', text: 'Legacy response.' },
    ])
  })
})

describe('reduceThread — stable source identities under history prepend', () => {
  it('keeps an existing turn key when an older page is prepended', () => {
    const tail = [
      line(100, 'turn.started', { turnId: 'tail' }),
      line(101, 'item.completed', {
        item: { kind: 'message', id: 'm-tail', role: 'assistant', text: 'tail' },
      }),
    ]
    const tailId = reduceThread(tail).turns[0]!.id
    const withOlder = reduceThread([
      line(10, 'turn.started', { turnId: 'older' }),
      line(11, 'item.completed', {
        item: { kind: 'message', id: 'm-old', role: 'assistant', text: 'old' },
      }),
      ...tail,
    ])
    expect(tailId).toBe('turn-seq-100')
    expect(withOlder.turns[1]!.id).toBe(tailId)
  })
})

describe('reduceThread — v1-only fallback (pre-v2 transcripts)', () => {
  it('hides Codex collaboration bookkeeping that protocol v2 renders as grouped agents', () => {
    const { turns } = reduceThread([
      line(1, 'tool-call', { id: 'activity', tool: 'subAgentActivity', input: { kind: 'started' } }),
      line(2, 'tool-call', { id: 'wait', tool: 'collabAgentToolCall', input: { tool: 'wait' } }),
      line(3, 'tool-call', { id: 'wait-new', tool: 'collabToolCall', input: { tool: 'wait' } }),
    ])
    expect(turns.flatMap((turn) => turn.items)).toEqual([])
  })

  // Verbatim shapes from a real pre-R2 transcript (.ai/cezar/runs/2d012907….ndjson), trimmed.
  const v1Only: RunEvent[] = [
    line(1, 'lifecycle', { message: 'run started — workflow "quick-task" (runner: claude)' }),
    line(2, 'note', { message: 'worktree ready — branch cez/2d012907 (base main)' }),
    line(3, 'step-start', { stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 }),
    line(4, 'token-usage', { tokensUsed: 8993, stepId: 'task' }),
    line(5, 'text', { text: "Hi! I'm Claude Code, working in your **cezar** project.", stepId: 'task' }),
    line(7, 'tool-call', {
      id: 'toolu_01WJ',
      tool: 'Bash',
      input: { command: 'cat README.md | head -40', description: 'Read README' },
      stepId: 'task',
    }),
    line(9, 'tool-result', { toolCallId: 'toolu_01WJ', result: '# cezar ⚡\n\nParallel coding agents…', stepId: 'task' }),
    line(10, 'user-message', { text: 'Now summarize it.', imageCount: 0, stepId: 'task' }),
    line(11, 'text', { text: 'It orchestrates coding agents in worktrees.', stepId: 'task' }),
    line(12, 'error', { message: 'claude exited with code 1' }),
  ]

  it('synthesizes turns and items from v1 lines alone — nothing invented, 2-state tool status', () => {
    const { turns } = reduceThread(v1Only)
    expect(turns).toHaveLength(2)

    // Turn 1: dim lines, the assistant text, the completed tool.
    expect(kinds(turns[0]!.items)).toEqual(['note', 'note', 'message', 'tool'])
    const tool = turns[0]!.items[3] as UiToolItem
    expect(tool.id).toBe('toolu_01WJ')
    expect(tool.title).toBe('Ran cat README.md | head -40') // via the shared toolDisplay model
    expect(tool.status).toBe('completed') // v1 has no failure signal — none is invented
    expect(tool.output).toContain('# cezar ⚡')

    // Turn 2: opened by the user-message, then the reply and the danger line.
    expect(turns[1]!.userMessage).toEqual({ text: 'Now summarize it.', imageCount: 0, images: [] })
    expect(kinds(turns[1]!.items)).toEqual(['message', 'note'])
    expect(turns[1]!.items[1]).toMatchObject({ tone: 'danger', text: 'claude exited with code 1' })
  })

  it('a tool with no result stays honestly running', () => {
    const { turns } = reduceThread(v1Only.slice(0, 6)) // everything up to (not including) the tool-result
    const tool = turns[0]!.items.at(-1) as UiToolItem
    expect(tool.status).toBe('running')
    expect(tool.output).toBeUndefined()
  })
})

describe('reduceThread — mixed v1+v2 files (the dedup rule)', () => {
  // Verbatim from an R2 dry-run transcript (CEZ_DRY_RUN=1, seq/ts as persisted): the v2 items
  // land FIRST, their v1 `text` twin one line later — the order the rule is grounded in.
  const md = '## Markdown fixture\n```ts\nconst answer: number = 42;\n```'
  const mixed: RunEvent[] = [
    line(1, 'lifecycle', { message: 'run started — workflow "quick-task" (runner: claude)' }),
    line(2, 'note', { message: 'worktree ready — branch cez/01ec2e8c (base main)' }),
    line(3, 'step-start', { stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 }),
    line(4, 'session.started', { sessionId: 'b3440f00', backend: 'claude', stepId: 'task' }),
    line(5, 'turn.started', { turnId: 'turn_1', stepId: 'task' }),
    line(6, 'item.started', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: md }, stepId: 'task' }),
    line(7, 'item.completed', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: md }, stepId: 'task' }),
    line(8, 'text', { text: md, stepId: 'task' }), // the v1 twin of item_1
    line(10, 'turn.completed', { turnId: 'turn_1', stopReason: 'end_turn', costUsd: 0.001, stepId: 'task' }),
    line(15, 'user-message', { text: 'Thanks — now list the components.', imageCount: 0, stepId: 'task' }),
    line(16, 'turn.started', { turnId: 'turn_2', stepId: 'task' }),
    line(17, 'item.started', { item: { kind: 'message', id: 'item_2', role: 'assistant', text: 'Follow-up #1 received.' }, stepId: 'task' }),
    line(18, 'item.completed', { item: { kind: 'message', id: 'item_2', role: 'assistant', text: 'Follow-up #1 received.' }, stepId: 'task' }),
    line(19, 'text', { text: 'Follow-up #1 received.', stepId: 'task' }), // the v1 twin of item_2
    line(21, 'turn.completed', { turnId: 'turn_2', stopReason: 'end_turn', stepId: 'task' }),
    line(26, 'lifecycle', { message: 'session closed by user' }),
    line(28, 'session.ended', { reason: 'end_turn', stepId: 'task' }),
  ]

  it('v2 wins per turn: each message renders once, notes and user bubbles still render', () => {
    const { turns, sessionEnded } = reduceThread(mixed)
    expect(turns).toHaveLength(2)

    // Turn 1 wears the v2 id and holds the two dim lines + exactly ONE copy of the message.
    expect(turns[0]!.turnId).toBe('turn_1')
    expect(kinds(turns[0]!.items)).toEqual(['note', 'note', 'message'])
    expect((turns[0]!.items[2] as UiMessageItem).id).toBe('item_1')

    // Turn 2: the v1 user-message opened it, the v2 turn.started attached to it (no phantom
    // extra turn), and the v1 text twin was dropped.
    expect(turns[1]!.turnId).toBe('turn_2')
    expect(turns[1]!.userMessage?.text).toBe('Thanks — now list the components.')
    expect(kinds(turns[1]!.items)).toEqual(['message', 'note'])

    expect(sessionEnded).toEqual({ reason: 'end_turn' })
  })

  it('the drop also works when a v1 line slips in BEFORE its v2 twin', () => {
    const reordered = [...mixed]
    // Swap the v1 text (index 7) ahead of the two item events (indices 5,6).
    const [started, completed, v1text] = [reordered[5]!, reordered[6]!, reordered[7]!]
    reordered[5] = v1text
    reordered[6] = started
    reordered[7] = completed
    const { turns } = reduceThread(reordered)
    expect(kinds(turns[0]!.items)).toEqual(['note', 'note', 'message'])
    expect((turns[0]!.items[2] as UiMessageItem).id).toBe('item_1')
  })

  it('v1 tool lines are skipped in a v2-covered turn, matched by the shared toolu id', () => {
    const withTools: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', {
        item: { kind: 'tool', id: 'toolu_A', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'running' },
      }),
      line(3, 'tool-call', { id: 'toolu_A', tool: 'Bash', input: { command: 'npm test' } }), // v1 twin
      line(4, 'item.completed', {
        item: { kind: 'tool', id: 'toolu_A', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'completed', output: 'ok' },
      }),
      line(5, 'tool-result', { toolCallId: 'toolu_A', result: 'ok' }), // v1 twin
    ]
    const { turns } = reduceThread(withTools)
    expect(kinds(turns[0]!.items)).toEqual(['tool'])
    expect((turns[0]!.items[0] as UiToolItem).status).toBe('completed')
  })

  // The vanishing-message regression: a turn can be v2-covered for TOOLS while its prose exists
  // only as a v1 `text` line (claude's `msg.result` fallback — see claude-ui-mapper's mapResult).
  // The old blanket "drop every v1 item once the latch flips" deleted that message a moment
  // after it rendered, leaving tool cards with no prose. Membership in v2 is now decided by
  // text, so an untwinned line survives.
  it('keeps a v1 text that has NO v2 message twin, even in a v2-covered turn', () => {
    const resultFallback: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'text', { text: 'Prose that only v1 ever described.' }),
      line(3, 'item.started', {
        item: { kind: 'tool', id: 'toolu_A', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'running' },
      }),
      line(4, 'item.completed', {
        item: { kind: 'tool', id: 'toolu_A', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'completed' },
      }),
    ]
    const { turns } = reduceThread(resultFallback)
    expect(kinds(turns[0]!.items)).toEqual(['message', 'tool'])
    expect((turns[0]!.items[0] as UiMessageItem).text).toBe('Prose that only v1 ever described.')
  })

  // The two vocabularies normalize markers differently — the server strips `CEZ:` from v1 `text`
  // before persisting, v2 items carry it raw — so the twin match has to strip both sides or
  // every final message in a run would render twice.
  it('matches a v1 twin against a v2 message whose text still carries its CEZ marker', () => {
    const finalTurn: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', {
        item: { kind: 'tool', id: 'toolu_A', name: 'Bash', toolKind: 'execute', title: 'Ran x', status: 'completed' },
      }),
      line(3, 'item.completed', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'All done.\n\nCEZ:DONE' } }),
      line(4, 'text', { text: 'All done.' }), // the server-stripped v1 twin
    ]
    const { turns } = reduceThread(finalTurn)
    expect(kinds(turns[0]!.items)).toEqual(['tool', 'message'])
    expect((turns[0]!.items[1] as UiMessageItem).text).toBe('All done.')
  })
})

describe('reduceThread — legacy per-delta transcripts (codex/opencode runs recorded before v1 text coalescing)', () => {
  // Verbatim shape from a real broken recording: the codex runner used to emit one v1 `text`
  // per streaming delta, so the file holds one line per token — and the exact-match dedup
  // never fired, rendering one paragraph per token. The v2 item carries the whole message.
  const full = 'QA done — see github.com/open-mercato/cezar/pull/628\n\nCEZ:DONE'
  // Per-token persistence: the server stripped markers per event (a split marker slips
  // through: CE / Z / :D / ONE) and dropped whitespace-only deltas entirely.
  const tokens = ['QA', ' done', ' —', ' see', ' github', '.com', '/open', '-merc', 'ato', '/ce', 'zar', '/p', 'ull', '/', '628', 'CE', 'Z', ':D', 'ONE']

  it('drops a token run that reassembles the v2 message — including the split CEZ:DONE', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: '' } }),
      line(3, 'item.completed', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: full } }),
      ...tokens.map((text, i) => line(4 + i, 'text', { text })),
      line(40, 'turn.completed', { turnId: 'turn_1', stopReason: 'end_turn' }),
    ]
    const { turns } = reduceThread(events)
    expect(kinds(turns[0]!.items)).toEqual(['message'])
    expect((turns[0]!.items[0] as UiMessageItem).id).toBe('item_1')
    expect((turns[0]!.items[0] as UiMessageItem).text).toBe('QA done — see github.com/open-mercato/cezar/pull/628')
  })

  it('drops one run spanning TWO v2 messages (v1 tool suppression made them adjacent)', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.completed', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'First thought.' } }),
      line(3, 'item.completed', { item: { kind: 'message', id: 'item_2', role: 'assistant', text: 'Second thought.' } }),
      line(4, 'text', { text: 'First' }),
      line(5, 'text', { text: ' thought.' }),
      line(6, 'text', { text: 'Second' }),
      line(7, 'text', { text: ' thought.' }),
    ]
    const { turns } = reduceThread(events)
    expect(kinds(turns[0]!.items)).toEqual(['message', 'message'])
  })

  it('keeps a run that reassembles NOTHING — v1-only prose never vanishes', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.completed', { item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'Unrelated v2 prose.' } }),
      line(3, 'text', { text: 'Two separate' }),
      line(4, 'text', { text: 'v1-only messages.' }),
    ]
    const { turns } = reduceThread(events)
    expect(kinds(turns[0]!.items)).toEqual(['message', 'message', 'message'])
  })

  it('does not touch v1-only transcripts (no v2 items — nothing to reassemble against)', () => {
    const events: RunEvent[] = [
      line(1, 'text', { text: 'First paragraph.' }),
      line(2, 'text', { text: 'Second paragraph.' }),
    ]
    const { turns } = reduceThread(events)
    expect(kinds(turns[0]!.items)).toEqual(['message', 'message'])
  })
})

describe('reduceThread — live-stream mechanics', () => {
  it('item.delta appends to the right field; a later snapshot replaces the accumulation', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', { item: { kind: 'message', id: 'm1', role: 'assistant', text: '' } }),
      line(3, 'item.delta', { itemId: 'm1', field: 'text', delta: 'Hel' }),
      line(4, 'item.delta', { itemId: 'm1', field: 'text', delta: 'lo' }),
      line(5, 'item.started', { item: { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'execute', title: 'Ran x', status: 'running' } }),
      line(6, 'item.delta', { itemId: 't1', field: 'output', delta: 'line 1\n' }),
      line(7, 'item.delta', { itemId: 't1', field: 'output', delta: 'line 2' }),
      line(8, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'Hello!' } }),
    ]
    const { turns } = reduceThread(events)
    const [message, tool] = turns[0]!.items as [UiMessageItem, UiToolItem]
    expect(message.text).toBe('Hello!') // snapshot wins over the delta accumulation
    expect(tool.output).toBe('line 1\nline 2')
    expect(tool.status).toBe('running')
  })

  it('does not mutate the input events (deltas land on clones)', () => {
    const started = line(2, 'item.started', { item: { kind: 'message', id: 'm1', role: 'assistant', text: '' } })
    reduceThread([line(1, 'turn.started', { turnId: 't' }), started, line(3, 'item.delta', { itemId: 'm1', field: 'text', delta: 'x' })])
    expect((started.item as { text: string }).text).toBe('')
  })

  it('strips a trailing CEZ:DONE from assistant messages — v2 carries it raw', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'All done.\n\nCEZ:DONE' } }),
    ]
    const { turns } = reduceThread(events)
    expect((turns[0]!.items[0] as UiMessageItem).text).toBe('All done.')
  })

  it('strips a trailing CEZ:MONITORING from assistant messages too (#490)', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.completed', {
        item: { kind: 'message', id: 'm1', role: 'assistant', text: 'Spawned the reviewer, waiting on it.\n\nCEZ:MONITORING' },
      }),
    ]
    const { turns } = reduceThread(events)
    expect((turns[0]!.items[0] as UiMessageItem).text).toBe('Spawned the reviewer, waiting on it.')
  })

  it('strips CEZ:PR/CEZ:ISSUE/CEZ:TITLE marker lines but keeps prose mentions (spec 2026-07-18-task-ref-markers)', () => {
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.completed', {
        item: {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: 'Opened the PR.\nCEZ:PR=442\nCEZ:ISSUE=433\nCEZ:TITLE=implementing marker refs\nI will keep CEZ:PR=442 updated.',
        },
      }),
    ]
    const { turns } = reduceThread(events)
    expect((turns[0]!.items[0] as UiMessageItem).text).toBe('Opened the PR.\nI will keep CEZ:PR=442 updated.')
  })

  it('a malformed line costs itself, not the fold', () => {
    const events: RunEvent[] = [
      line(1, 'item.delta', { itemId: 'ghost', field: 'text', delta: 'x' }), // delta before any item
      line(2, 'item.started', { item: null }), // broken payload
      line(3, 'tool-result', { toolCallId: 'nobody', result: 'orphan' }),
      line(4, 'text', { text: 'still here' }),
    ]
    const { turns } = reduceThread(events)
    expect(kinds(turns[0]!.items)).toEqual(['message'])
  })

  it('a failed step surfaces as a danger line; a passing one stays out of the thread', () => {
    const { turns } = reduceThread([
      line(1, 'step-end', { stepId: 'task', status: 'done' }),
      line(2, 'step-end', { stepId: 'check', status: 'failed', error: 'tests failed' }),
    ])
    expect(turns[0]!.items).toEqual([
      { kind: 'note', id: 'v1:2', text: 'step check failed — tests failed', tone: 'danger' },
    ])
  })

  it('renders v1 image lines (served URL) and skips everything without one', () => {
    const { turns } = reduceThread([
      line(1, 'image', { name: 'shot.png', url: '/api/v1/runs/r1/images/shot.png' }),
      line(2, 'image', { mediaType: 'image/png', data: 'aGk=' }), // v2 shape: raw base64, no URL
    ])
    expect(turns[0]!.items).toEqual([
      { kind: 'image', id: 'v1:1', url: '/api/v1/runs/r1/images/shot.png', name: 'shot.png' },
    ])
  })
})

describe('latestPlanEntries — the dock takes the newest snapshot across turns', () => {
  const plan = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status })

  it('latest wins across turns (full-replacement semantics)', () => {
    const state = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'plan.updated', { entries: [plan('a', 'in_progress'), plan('b', 'pending')] }),
      line(3, 'user-message', { text: 'go on', imageCount: 0 }),
      line(4, 'turn.started', { turnId: 'turn_2' }),
      line(5, 'plan.updated', { entries: [plan('a', 'completed'), plan('b', 'in_progress')] }),
    ])
    expect(state.turns).toHaveLength(2)
    expect(latestPlanEntries(state)).toEqual([plan('a', 'completed'), plan('b', 'in_progress')])
  })

  it('within one turn the later snapshot replaces the earlier one', () => {
    const state = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'plan.updated', { entries: [plan('a', 'pending')] }),
      line(3, 'plan.updated', { entries: [plan('a', 'in_progress'), plan('b', 'pending')] }),
    ])
    expect(latestPlanEntries(state)).toEqual([plan('a', 'in_progress'), plan('b', 'pending')])
  })

  it('an emptied latest snapshot still wins (it replaced the plan with nothing)', () => {
    const state = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'plan.updated', { entries: [plan('a', 'pending')] }),
      line(3, 'user-message', { text: 'scrap it', imageCount: 0 }),
      line(4, 'plan.updated', { entries: [] }),
    ])
    expect(latestPlanEntries(state)).toEqual([])
  })

  it('no plan.updated anywhere → undefined (the dock stays hidden)', () => {
    expect(latestPlanEntries(reduceThread([line(1, 'text', { text: 'hi' })]))).toBeUndefined()
  })

  it('v1-only fallback: a TodoWrite tool-call input yields the plan for old transcripts', () => {
    const todos = [
      { content: 'Patch middleware redirect', status: 'completed', activeForm: 'Patching middleware redirect' },
      { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    ]
    const state = reduceThread([
      line(1, 'tool-call', { id: 'toolu_01EF', tool: 'TodoWrite', input: { todos }, stepId: 'task' }),
    ])
    expect(latestPlanEntries(state)).toEqual(todos)
    // The plan-kind tool item itself is still synthesized — hiding it is the grouping's job.
    expect((state.turns[0]!.items[0] as UiToolItem).toolKind).toBe('plan')
  })

  it('v1 fallback is all-or-nothing: a malformed todos array yields no plan', () => {
    const state = reduceThread([
      line(1, 'tool-call', { id: 't1', tool: 'TodoWrite', input: { todos: [{ status: 'pending' }] } }), // no content
      line(2, 'tool-call', { id: 't2', tool: 'TodoWrite', input: { notTodos: true } }),
    ])
    expect(latestPlanEntries(state)).toBeUndefined()
  })
})

describe('reduceThread — check-output (check steps, v1-only by nature)', () => {
  it('a passing check becomes a completed execute card with the exit code and output', () => {
    // Verbatim shape from src/workflows/run.ts runCheckStep().
    const { turns } = reduceThread([
      line(1, 'note', { message: '$ npm test', stepId: 'verify' }),
      line(2, 'check-output', { stepId: 'verify', command: 'npm test', text: '72 passing (1.2s)', exitCode: 0 }),
    ])
    expect(kinds(turns[0]!.items)).toEqual(['note', 'tool'])
    expect(turns[0]!.items[1]).toEqual({
      kind: 'tool',
      id: 'v1:2',
      name: 'check',
      toolKind: 'execute',
      title: 'Ran npm test',
      status: 'completed',
      output: '72 passing (1.2s)',
      exitCode: 0,
    })
  })

  it('a failing check is a failed card; a spawn failure (exitCode -1) too', () => {
    const { turns } = reduceThread([
      line(1, 'check-output', { stepId: 'verify', command: 'npm test', text: '1 failing', exitCode: 2 }),
      line(2, 'check-output', { stepId: 'verify', command: 'nope', text: 'failed to spawn: ENOENT', exitCode: -1 }),
    ])
    const [failed, spawn] = turns[0]!.items as [UiToolItem, UiToolItem]
    expect(failed).toMatchObject({ status: 'failed', exitCode: 2, output: '1 failing' })
    expect(spawn).toMatchObject({ status: 'failed', exitCode: -1 })
  })

  it('survives inside a v2-covered turn (it is meta, not an agent item twin)', () => {
    const { turns } = reduceThread([
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'done' } }),
      line(3, 'check-output', { stepId: 'verify', command: 'npm test', text: 'ok', exitCode: 0 }),
    ])
    expect(kinds(turns[0]!.items)).toEqual(['message', 'tool'])
  })
})

describe('reduceThread — provider authorization recovery', () => {
  it('persists a valid provider authorization incident in its failure turn', () => {
    expect(reduceThread([
      line(1, 'provider-auth-required', {
        provider: 'claude',
        authFailureId: 'incident-1',
        stepId: 'work',
      }),
    ]).turns[0]?.items).toEqual([{
      kind: 'provider-auth-required',
      id: 'v1:1',
      provider: 'claude',
      authFailureId: 'incident-1',
    }])
  })

  it.each([
    ['an unknown provider', { provider: 'future', authFailureId: 'incident-1' }],
    ['a blank incident id', { provider: 'claude', authFailureId: '' }],
    ['an overlong incident id', { provider: 'claude', authFailureId: 'x'.repeat(129) }],
    ['a malformed payload', { provider: ['claude'], authFailureId: 'incident-1' }],
  ])('ignores %s without losing surrounding transcript entries', (_name, payload) => {
    const { turns } = reduceThread([
      line(1, 'note', { message: 'before' }),
      line(2, 'provider-auth-required', payload),
      line(3, 'note', { message: 'after' }),
    ])
    expect(turns[0]?.items).toEqual([
      { kind: 'note', id: 'v1:1', text: 'before', tone: 'dim' },
      { kind: 'note', id: 'v1:3', text: 'after', tone: 'dim' },
    ])
  })

  it('replays the persisted incident deterministically', () => {
    const events = [
      line(1, 'turn.started', { turnId: 'turn-1' }),
      line(2, 'provider-auth-required', { provider: 'codex', authFailureId: 'incident-2' }),
      line(3, 'turn.completed', { turnId: 'turn-1', stopReason: 'error' }),
    ]
    expect(reduceThread(events)).toEqual(reduceThread(events))
  })
})

describe('threadFooter', () => {
  const cases = [
    ['waiting', undefined, { state: 'waiting' }],
    ['done', undefined, { state: 'closed', tone: 'dim', label: 'Session closed' }],
    ['cancelled', undefined, { state: 'closed', tone: 'dim', label: 'Session closed' }],
    ['review', undefined, { state: 'closed', tone: 'dim', label: 'Session closed — waiting for your review' }],
    ['failed', 'checks failed', { state: 'closed', tone: 'danger', label: 'Session failed — checks failed' }],
    ['failed', undefined, { state: 'closed', tone: 'danger', label: 'Session failed' }],
    ['running', undefined, null],
    ['queued', undefined, null],
  ] as const

  for (const [status, error, expected] of cases) {
    it(`${status}${error ? ` (${error})` : ''} → ${expected ? expected.state : 'nothing'}`, () => {
      expect(threadFooter(status, error)).toEqual(expected)
    })
  }
})

describe('threadFilePaths — the @ mention source (today: what the tools touched)', () => {
  const tool = (id: string, extra: Record<string, unknown>): RunEvent =>
    line(Number(id.replace(/\D/g, '')), 'item.completed', {
      item: {
        kind: 'tool',
        id,
        name: 'Edit',
        toolKind: 'edit',
        title: 'Edit file',
        status: 'completed',
        ...extra,
      },
    })

  it('collects locations and diff paths, deduped, most recently touched first', () => {
    const state = reduceThread([
      line(1, 'turn.started', { turnId: 't1' }),
      tool('i1', { locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts', line: 3 }] }),
      tool('i2', { diffs: [{ path: 'src/c.ts', oldText: null }] }),
      tool('i3', { locations: [{ path: 'src/a.ts' }] }), // a.ts touched again — moves to front
    ])
    expect(threadFilePaths(state)).toEqual(['src/a.ts', 'src/c.ts', 'src/b.ts'])
  })

  it('non-tool items and tools without locations contribute nothing', () => {
    const state = reduceThread([
      line(1, 'turn.started', { turnId: 't1' }),
      line(2, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'hi' } }),
      tool('i3', {}),
    ])
    expect(threadFilePaths(state)).toEqual([])
  })
})

describe('the v1 vocabulary sweep (cezar-code-map §3.2) — every persisted type renders or is a documented suppression', () => {
  const allItems = (events: RunEvent[]): ThreadEntry[] =>
    reduceThread(events).turns.flatMap((turn) => turn.items)

  // -- types that RENDER ------------------------------------------------------------------

  it('text → an assistant message', () => {
    const items = allItems([line(1, 'text', { text: 'hello' })])
    expect(items).toEqual([{ kind: 'message', id: 'v1:1', role: 'assistant', text: 'hello' }])
  })

  it('tool-call + tool-result → one tool card, honest 2-state status', () => {
    const items = allItems([
      line(1, 'tool-call', { id: 't1', tool: 'Bash', input: { command: 'ls' } }),
      line(2, 'tool-result', { toolCallId: 't1', result: 'a.ts' }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', status: 'completed', output: 'a.ts' })
  })

  it('note / lifecycle → dim lines', () => {
    const items = allItems([
      line(1, 'note', { message: 'worktree ready' }),
      line(2, 'lifecycle', { message: 'run started' }),
    ])
    expect(items).toEqual([
      { kind: 'note', id: 'v1:1', text: 'worktree ready', tone: 'dim' },
      { kind: 'note', id: 'v1:2', text: 'run started', tone: 'dim' },
    ])
  })

  it('error → a danger line', () => {
    expect(allItems([line(1, 'error', { message: 'claude exited with code 1' })])).toEqual([
      { kind: 'note', id: 'v1:1', text: 'claude exited with code 1', tone: 'danger' },
    ])
  })

  it('user-message → opens a turn with the bubble', () => {
    const { turns } = reduceThread([line(1, 'user-message', { text: 'do it', imageCount: 1 })])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.userMessage).toEqual({ text: 'do it', imageCount: 1, images: [] })
  })

  it('user-message carries attached image URLs for the bubble (#image-display)', () => {
    const { turns } = reduceThread([
      line(1, 'user-message', {
        text: "there's still error",
        imageCount: 1,
        images: ['/api/v1/runs/r1/images/screenshot-1.png'],
      }),
    ])
    expect(turns[0]!.userMessage?.images).toEqual(['/api/v1/runs/r1/images/screenshot-1.png'])
  })

  it('image (the URL-bearing v1 line) → a thread image', () => {
    expect(allItems([line(1, 'image', { url: '/api/v1/runs/r/images/s.png', name: 's.png' })])).toEqual([
      { kind: 'image', id: 'v1:1', url: '/api/v1/runs/r/images/s.png', name: 's.png' },
    ])
  })

  it('check-output → an execute card carrying the exit-code verdict', () => {
    const items = allItems([
      line(1, 'check-output', { stepId: 'verify', command: 'npm test', exitCode: 1, text: '1 failed' }),
    ])
    expect(items[0]).toMatchObject({ kind: 'tool', toolKind: 'execute', status: 'failed', exitCode: 1 })
  })

  it('step-end failed → the one step fact the transcript must not hide', () => {
    expect(allItems([line(1, 'step-end', { stepId: 'task', status: 'failed', error: 'boom' })])).toEqual([
      { kind: 'note', id: 'v1:1', text: 'step task failed — boom', tone: 'danger' },
    ])
  })

  // -- DOCUMENTED suppressions (the surface that owns each is named in the reducer) ---------

  it.each([
    ['step-start', { stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 }], // step rail
    ['step-end', { stepId: 'task', status: 'done' }], // step rail (non-failed)
    ['token-usage', { tokensUsed: 4200 }], // header meta (record totals)
    ['cost', { usd: 0.03 }], // header meta
    ['turn-end', {}], // engine control flow
    ['done', {}], // shadowed by its lifecycle line
    ['session', { sessionId: 'abc-123' }], // header resume hint (record sessionId)
  ])('%s → deliberately nothing in the thread body', (type, rest) => {
    const state = reduceThread([line(1, type, rest)])
    expect(state.turns.flatMap((turn) => turn.items)).toEqual([])
  })

  it('unknown future types → nothing, never a guessed rendering (divergence from the legacy raw-JSON note, on purpose)', () => {
    expect(allItems([line(1, 'telemetry.fancy', { whatever: true })])).toEqual([])
  })
})

describe('reduceThread — AskUser cards (#473)', () => {
  const allItems = (events: RunEvent[]): ThreadEntry[] =>
    reduceThread(events).turns.flatMap((turn) => turn.items)

  const ASK = {
    requestId: 'ask_1',
    questions: [
      { header: 'Library', question: 'Which?', options: [{ label: 'date-fns' }, { label: 'Luxon' }] },
    ],
  }

  it('ask.requested → an unresolved ask entry in the current turn', () => {
    const ask = allItems([
      line(1, 'text', { text: 'Here are the options.' }),
      line(2, 'ask.requested', ASK),
    ]).find((i) => i.kind === 'ask')
    expect(ask).toMatchObject({ kind: 'ask', id: 'ask_1', resolved: false })
  })

  it('the next user-message resolves the ask and records the answer', () => {
    const ask = allItems([
      line(1, 'text', { text: 'options' }),
      line(2, 'ask.requested', ASK),
      line(3, 'user-message', { text: 'Library: date-fns', imageCount: 0 }),
    ]).find((i) => i.kind === 'ask')
    expect(ask).toMatchObject({ resolved: true, answer: 'Library: date-fns' })
  })

  // The card outlives its session: the run closed with the question unanswered, and the
  // answer arrives as the opening `user-message` of a CONTINUATION step (`POST /continue`,
  // `runContinuation`). Nothing about resolution is session-scoped, and this pins that —
  // it is what makes answering a closed run's question read the same as answering a live one.
  it('a continuation step resolves an ask left pending when the session ended', () => {
    const ask = allItems([
      line(1, 'text', { text: 'options', stepId: 'task' }),
      line(2, 'ask.requested', { ...ASK, stepId: 'task' }),
      line(3, 'lifecycle', { message: 'session closed by user' }),
      line(4, 'step-start', { stepId: 'continue-1', name: 'Continue', kind: 'agent', iteration: 1 }),
      line(5, 'user-message', { text: 'Library: date-fns', imageCount: 0, stepId: 'continue-1' }),
    ]).find((i) => i.kind === 'ask')
    expect(ask).toMatchObject({ resolved: true, answer: 'Library: date-fns' })
  })

  it('drops an ask.requested with no valid questions', () => {
    expect(
      allItems([line(1, 'ask.requested', { requestId: 'x', questions: [] })]).some(
        (i) => i.kind === 'ask',
      ),
    ).toBe(false)
  })

  it('strips a CEZ:ASK marker from a v2 assistant message when its turn holds the ask card', () => {
    const markerJson = JSON.stringify({ questions: ASK.questions })
    const msg = allItems([
      line(1, 'item.completed', {
        item: { kind: 'message', id: 'm1', role: 'assistant', text: `Pick one.\n\nCEZ:ASK ${markerJson}` },
      }),
      line(2, 'ask.requested', ASK),
    ]).find((i) => i.kind === 'message') as { text: string } | undefined
    expect(msg?.text).toBe('Pick one.')
  })

  it('suppresses a complete provisional marker during the active turn', () => {
    const markerJson = JSON.stringify({ questions: ASK.questions })
    const events = [
      line(1, 'item.completed', {
        item: { kind: 'message', id: 'm1', role: 'assistant', text: `Pick one.\n\nCEZ:ASK ${markerJson}` },
      }),
    ]
    const msg = reduceThread(events, { activeTurn: true }).turns[0]!.items.find(
      (item) => item.kind === 'message',
    ) as { text: string } | undefined
    expect(msg?.text).toBe('Pick one.')
  })

  // Regression (blank-question bug): a marker whose card never materialized —
  // invalid payload, or the session died before turn-end emitted ask.requested —
  // must stay visible. The card is the only other place the questions exist;
  // stripping without it deletes the agent's question from the thread entirely.
  it('keeps a CEZ:ASK marker visible when no ask card landed in the turn', () => {
    const raw = 'Zanim pójdziemy dalej, trzy pytania:\n\nCEZ:ASK {"questions":[]}'
    const msg = allItems([
      line(1, 'item.completed', {
        item: { kind: 'message', id: 'm1', role: 'assistant', text: raw },
      }),
    ]).find((i) => i.kind === 'message') as { text: string } | undefined
    expect(msg?.text).toBe(raw)
  })

  it('restores a hard-invalid marker when the active turn settles without a card', () => {
    const raw = 'Pick one.\n\nCEZ:ASK {"questions":[]}'
    const events = [
      line(1, 'item.completed', {
        item: { kind: 'message', id: 'm1', role: 'assistant', text: raw },
      }),
    ]
    const active = reduceThread(events, { activeTurn: true }).turns[0]!.items.find(
      (item) => item.kind === 'message',
    ) as { text: string } | undefined
    const settled = reduceThread(events).turns[0]!.items.find(
      (item) => item.kind === 'message',
    ) as { text: string } | undefined
    expect(active?.text).toBe('Pick one.')
    expect(settled?.text).toBe(raw)
  })

  it("an ask card in ANOTHER turn does not license stripping this turn's marker", () => {
    const raw = 'Second turn question:\n\nCEZ:ASK {"questions":[]}'
    const { turns } = reduceThread([
      line(1, 'text', { text: 'options' }),
      line(2, 'ask.requested', ASK),
      line(3, 'user-message', { text: 'Library: date-fns', imageCount: 0 }),
      line(4, 'item.completed', {
        item: { kind: 'message', id: 'm2', role: 'assistant', text: raw },
      }),
    ])
    const msg = turns.at(-1)!.items.find((i) => i.kind === 'message') as { text: string } | undefined
    expect(msg?.text).toBe(raw)
  })
})

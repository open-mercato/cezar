import { describe, expect, it } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'
import type { ToolStatus, UiToolItem } from '@open-mercato/cezar-api-client'

import subagentTask from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import {
  activitySummary,
  groupThreadItems,
  noteGroupSummary,
  splitToolTitle,
  type ThreadBlock,
} from './thread-groups'
import { reduceThread, type ThreadEntry, type ThreadNote } from './thread-state'

/** Golden fixtures are `UiEvent[]` — stamp the wire's seq/ts on them, as the store does. */
const asRunEvents = (events: object[]): RunEvent[] =>
  events.map((event, index) => ({ seq: index + 1, ts: '2026-07-14T12:00:00.000Z', ...event }) as RunEvent)

/** A tool item in the exact shape the R2 mappers emit (title/toolKind precomputed). */
const tool = (id: string, toolKind: UiToolItem['toolKind'], status: ToolStatus, extra: Partial<UiToolItem> = {}): UiToolItem => ({
  kind: 'tool',
  id,
  name: toolKind === 'read' ? 'Read' : toolKind === 'search' ? 'Grep' : 'Bash',
  toolKind,
  title: toolKind === 'read' ? `Read /repo/${id}.ts` : toolKind === 'search' ? `Search ${id}` : `Ran ${id}`,
  status,
  ...extra,
})

const note = (id: string): ThreadNote => ({ kind: 'note', id, text: `note ${id}`, tone: 'dim' })
const msg = (id: string): ThreadEntry => ({ kind: 'message', id, role: 'assistant', text: `prose ${id}` })

const shape = (blocks: ThreadBlock[]) => blocks.map((b) => b.kind)

describe('groupThreadItems — activity groups', () => {
  it('collapses ≥2 consecutive tool calls of any kind into one summarized row', () => {
    const blocks = groupThreadItems([
      msg('m1'),
      tool('a', 'read', 'completed'),
      tool('b', 'read', 'completed'),
      tool('c', 'search', 'completed'),
      tool('run', 'execute', 'completed', { output: 'ok' }),
      tool('e', 'edit', 'completed'),
      msg('m2'),
    ])
    expect(shape(blocks)).toEqual(['entry', 'activity', 'entry'])
    const group = blocks[1]!
    if (group.kind !== 'activity') throw new Error('expected an activity group')
    expect(group.tools.map((t) => t.id)).toEqual(['a', 'b', 'c', 'run', 'e'])
    expect(group.summary).toBe('Read 2 files, searched once, ran 1 command, edited 1 file')
    expect(group.current).toBeUndefined()
    expect(group.failed).toBe(0)
  })

  it('a single tool call stays an individual card — grouping needs at least two', () => {
    const blocks = groupThreadItems([tool('a', 'read', 'completed'), msg('m1')])
    expect(shape(blocks)).toEqual(['tool-card', 'entry'])
  })

  it('names the newest running call as the current one, and counts failures', () => {
    const blocks = groupThreadItems([
      tool('a', 'execute', 'failed'),
      tool('b', 'read', 'completed'),
      tool('c', 'execute', 'running'),
    ])
    expect(shape(blocks)).toEqual(['activity'])
    const group = blocks[0]!
    if (group.kind !== 'activity') throw new Error('expected an activity group')
    expect(group.current?.id).toBe('c')
    expect(group.failed).toBe(1)
    expect(group.id).toBe('activity:a')
  })

  it('a non-tool entry breaks consecutiveness', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      msg('m1'),
      tool('b', 'read', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['tool-card', 'entry', 'tool-card'])
  })

  it('reasoning BETWEEN tools folds into the group; a trailing thought stays on screen', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      { kind: 'reasoning', id: 'r1', text: 'Now the store.' },
      tool('b', 'read', 'completed'),
      { kind: 'reasoning', id: 'r2', text: 'Done exploring.' },
    ])
    expect(shape(blocks)).toEqual(['activity', 'entry'])
    const group = blocks[0]!
    if (group.kind !== 'activity') throw new Error('expected an activity group')
    expect(group.blocks.map((b) => b.id)).toEqual(['a', 'r1', 'b'])
    expect(blocks[1]!.id).toBe('r2')
  })

  it('a tool that adopted sub-agent children stays its own card and breaks the run', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      tool('b', 'read', 'completed'),
      tool('task', 'task', 'completed', { name: 'Task', title: 'Task: audit' }),
      tool('kid', 'execute', 'completed', { parentItemId: 'task' }),
      tool('c', 'read', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['activity', 'tool-card', 'tool-card'])
    expect(blocks[1]).toMatchObject({ kind: 'tool-card', id: 'task', children: [expect.objectContaining({ id: 'kid' })] })
  })
})

describe('activitySummary', () => {
  it('counts distinct files, in the order the kinds first appear', () => {
    expect(activitySummary([
      tool('cmd', 'execute', 'completed'),
      tool('x', 'read', 'completed'),
      tool('x2', 'read', 'completed', { title: 'Read /repo/x.ts' }),
      tool('s1', 'search', 'completed'),
      tool('s2', 'search', 'completed'),
      tool('s3', 'search', 'completed'),
    ])).toBe('Ran 1 command, read 1 file, searched 3 times')
  })

  it.each([
    [[tool('s', 'search', 'completed'), tool('t', 'search', 'completed')], 'Searched twice'],
    [[tool('f', 'fetch', 'completed'), tool('g', 'fetch', 'completed')], 'Fetched 2 pages'],
    [[tool('k', 'skill', 'completed', { title: 'Skill: docs' })], 'Used skill docs'],
    [[tool('o', 'other', 'completed'), tool('p', 'other', 'completed')], 'Used 2 tools'],
    [
      [
        tool('d', 'delete', 'completed', { title: 'Delete /a' }),
        tool('e', 'edit', 'completed', { diffs: [{ path: '/b', oldText: null, newText: 'x' }] }),
      ],
      'Deleted 1 file, edited 1 file',
    ],
  ])('case %# → %s', (tools, summary) => {
    expect(activitySummary(tools)).toBe(summary)
  })
})

describe('groupThreadItems — note groups', () => {
  const setup = [
    'run started — workflow "implement-and-e2e" (runner: claude)',
    'worktree on — using an isolated task worktree (default)',
    'local "main" diverged from "origin/main" — forking from "origin/main"; local-only commits are not in this task',
    'worktree ready — branch cez/571c15ae (base origin/main)',
    '$ npm ci --prefer-offline --no-audit',
    "skills installed in the task's workspace: docs",
  ].map((text, index): ThreadNote => ({ kind: 'note', id: `n${index}`, text, tone: 'dim' }))

  it('folds the setup notes into one summary row and keeps the warnings visible', () => {
    const blocks = groupThreadItems([...setup, msg('m1')])
    expect(shape(blocks)).toEqual(['note-group', 'entry'])
    const group = blocks[0]!
    if (group.kind !== 'note-group') throw new Error('expected a note group')
    expect(group.summary).toBe('Set up: worktree cez/571c15ae from origin/main · installed deps · skills docs · runner Claude')
    expect(group.notes).toHaveLength(6)
    expect(group.warnings.map((n) => n.id)).toEqual(['n2'])
  })

  it('treats a model-naming fallback and an info note as warnings inside the group', () => {
    const naming: ThreadNote = { kind: 'note', id: 'nm', text: 'model naming unavailable — codex: no login', tone: 'dim' }
    const manager: ThreadNote = { kind: 'note', id: 'mg', text: 'Agent chosen by manager X: claude', tone: 'info' }
    const blocks = groupThreadItems([manager, naming, setup[0]!])
    const group = blocks[0]!
    if (group.kind !== 'note-group') throw new Error('expected a note group')
    expect(group.warnings.map((n) => n.id)).toEqual(['mg', 'nm'])
    expect(group.summary).toBe('Set up: runner Claude')
  })

  it('a non-setup run of notes joins its texts', () => {
    expect(noteGroupSummary([note('a'), note('b')])).toBe('note a · note b')
  })

  it('danger notes, failure summaries and action notes never fold', () => {
    const blocks = groupThreadItems([
      note('a'),
      { kind: 'note', id: 'd', text: 'boom', tone: 'danger' },
      note('b'),
      { kind: 'note', id: 'f', text: 'run stopped — the session closed', tone: 'dim' },
      note('c'),
      { kind: 'note', id: 's', text: 'skills missing', tone: 'dim', action: 'install-skills' },
    ])
    expect(shape(blocks)).toEqual(['entry', 'entry', 'entry', 'entry', 'entry', 'entry'])
  })

  it('a single note stays a plain line', () => {
    expect(shape(groupThreadItems([note('a'), msg('m')]))).toEqual(['entry', 'entry'])
  })
})

describe('groupThreadItems — sub-agent nesting (golden subagent-task fixture)', () => {
  it('items with parentItemId nest under their Task tool card, one level, in stream order', () => {
    const { turns } = reduceThread(asRunEvents(subagentTask))
    const blocks = groupThreadItems(turns[0]!.items)
    const task = blocks.find((b) => b.kind === 'tool-card')
    if (task?.kind !== 'tool-card') throw new Error('expected the Task tool card')
    expect(task.item.name).toBe('Task')
    expect(task.children.map((c) => c.kind)).toEqual(['message', 'tool'])
    expect(task.children.map((c) => c.id)).toEqual(['item_1', 'toolu_sub_01'])
    // The nested items do NOT render at top level.
    const topIds = blocks.map((b) => b.id)
    expect(topIds).not.toContain('item_1')
    expect(topIds).not.toContain('toolu_sub_01')
    // The parent's own final message stays top-level.
    expect(blocks.at(-1)).toMatchObject({ kind: 'entry', id: 'item_2' })
  })

  it('an orphaned parentItemId (parent not in this turn) renders at top level, never dropped', () => {
    const blocks = groupThreadItems([
      { kind: 'message', id: 'm1', role: 'assistant', text: 'hi', parentItemId: 'gone' },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'entry', id: 'm1' })
  })

  it('the golden edit/write/todo turn: edit and write fold into one activity row, the TodoWrite card is gone', () => {
    const { turns } = reduceThread(asRunEvents(thinkingEditWriteTodo))
    // The reducer still carries the plan tool item (5 entries) — grouping hides it (#382):
    // the plan dock is its surface, so the thread shows only the edit/write cards.
    expect(turns[0]!.items.filter((i) => i.kind === 'tool')).toHaveLength(3)
    const blocks = groupThreadItems(turns[0]!.items)
    expect(shape(blocks)).toEqual(['entry', 'entry', 'activity'])
    const group = blocks[2]!
    if (group.kind !== 'activity') throw new Error('expected an activity group')
    expect(group.tools.map((item) => item.toolKind)).toEqual(['edit', 'edit'])
    expect(group.summary).toBe('Edited 2 files')
  })

  it('plan-kind tools are dropped everywhere — top level and inside children lists', () => {
    const blocks = groupThreadItems([
      tool('planner', 'plan', 'completed', { name: 'TodoWrite', title: 'Update plan' }),
      tool('parent', 'task', 'running', { name: 'Task', title: 'Task: audit' }),
      tool('nested-plan', 'plan', 'completed', { name: 'TodoWrite', title: 'Update plan', parentItemId: 'parent' }),
      tool('nested-bash', 'execute', 'completed', { parentItemId: 'parent' }),
    ])
    expect(shape(blocks)).toEqual(['tool-card'])
    const card = blocks[0]!
    if (card.kind !== 'tool-card') throw new Error('expected a tool card')
    expect(card.item.id).toBe('parent')
    expect(card.children.map((child) => child.id)).toEqual(['nested-bash'])
  })
})

describe('splitToolTitle', () => {
  it.each([
    ['Ran npm test', 'Ran', 'npm test'],
    ['Edit /repo/src/middleware.ts', 'Edit', '/repo/src/middleware.ts'],
    ['Write /repo/src/middleware.test.ts', 'Write', '/repo/src/middleware.test.ts'],
    ['Read /repo/README.md', 'Read', '/repo/README.md'],
    ['Search TODO', 'Search', 'TODO'],
    ['Web search react docs', 'Web search', 'react docs'],
    ['Fetch https://example.com', 'Fetch', 'https://example.com'],
    ['Task: audit the auth flow', 'Task', 'audit the auth flow'],
  ])('%s → verb %s + detail', (title, verb, detail) => {
    expect(splitToolTitle(title)).toEqual({ verb, detail })
  })

  it.each([
    ['Update plan'],
    ['Screenshot'],
    ['linear.create_issue'],
    ['Ran'], // bare verb (no argument extracted) — nothing to split
  ])('%s stays whole as the verb', (title) => {
    expect(splitToolTitle(title)).toEqual({ verb: title })
  })
})

/** #528 — a reasoning item with no text renders as a dead row. It is dropped
 *  during grouping (like plan tools) so it never reaches the always-rendered
 *  `thread-row` wrapper, which would otherwise leave a blank gap. */
describe('groupThreadItems — blank reasoning items (#528)', () => {
  const reasoning = (id: string, text: string): ThreadEntry => ({ kind: 'reasoning', id, text })

  it.each([['', 'empty'], ['   ', 'spaces'], ['\n\t ', 'whitespace']])(
    'drops a %s reasoning entry (%s)',
    (text) => {
      expect(groupThreadItems([reasoning('r1', text)])).toEqual([])
    },
  )

  it('keeps reasoning that has text, and drops only the blank sibling', () => {
    const blocks = groupThreadItems([reasoning('r1', ''), reasoning('r2', 'Real thinking.')])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'entry', entry: { id: 'r2', text: 'Real thinking.' } })
  })
})

describe('groupThreadItems — provider authorization recovery', () => {
  it('keeps the recovery callout as an ordinary top-level entry at the failure location', () => {
    const { turns } = reduceThread([
      { seq: 1, ts: '2026-07-22T12:00:00.000Z', type: 'note', message: 'starting work' } as RunEvent,
      {
        seq: 2,
        ts: '2026-07-22T12:00:00.000Z',
        type: 'provider-auth-required',
        provider: 'opencode',
        authFailureId: 'incident-3',
      } as RunEvent,
      { seq: 3, ts: '2026-07-22T12:00:00.000Z', type: 'note', message: 'run stopped' } as RunEvent,
    ])

    expect(groupThreadItems(turns[0]?.items ?? [])).toEqual([
      expect.objectContaining({ kind: 'entry', id: 'v1:1' }),
      expect.objectContaining({ kind: 'entry', id: 'v1:2', entry: {
        kind: 'provider-auth-required',
        id: 'v1:2',
        provider: 'opencode',
        authFailureId: 'incident-3',
      } }),
      expect.objectContaining({ kind: 'entry', id: 'v1:3' }),
    ])
  })
})

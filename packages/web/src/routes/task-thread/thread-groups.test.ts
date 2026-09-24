import { describe, expect, it } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'
import type { ToolStatus, UiToolItem } from '@open-mercato/cezar-api-client'

import subagentTask from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import {
  contextGroupLabel,
  groupThreadItems,
  splitToolTitle,
  streakLabel,
  STREAK_TAIL,
  type ThreadBlock,
} from './thread-groups'
import { reduceThread, type ThreadEntry } from './thread-state'

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

const note = (id: string): ThreadEntry => ({ kind: 'note', id, text: `note ${id}`, tone: 'dim' })

const shape = (blocks: ThreadBlock[]) => blocks.map((b) => b.kind)

describe('groupThreadItems — context groups', () => {
  it('collapses ≥2 consecutive completed read/search tools into one labeled group', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      tool('b', 'read', 'completed'),
      tool('c', 'search', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['context-group'])
    const group = blocks[0]!
    if (group.kind !== 'context-group') throw new Error('expected a context group')
    expect(group.tools.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(group.files).toBe(2)
    expect(group.searches).toBe(1)
    expect(group.label).toBe('Explored 2 files · 1 search')
  })

  it('a single read stays an individual card — grouping needs at least two', () => {
    const blocks = groupThreadItems([tool('a', 'read', 'completed'), note('n1')])
    expect(shape(blocks)).toEqual(['tool-card', 'entry'])
  })

  it('only read/search kinds group; execute/edit stay visible as cards between groups', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      tool('b', 'read', 'completed'),
      tool('run', 'execute', 'completed', { output: 'ok' }),
      tool('c', 'search', 'completed'),
      tool('d', 'search', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['context-group', 'tool-card', 'context-group'])
  })

  it('only COMPLETED tools group — a running read breaks the run and renders as its own card', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      tool('b', 'read', 'running'),
      tool('c', 'read', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['tool-card', 'tool-card', 'tool-card'])
  })

  it('a non-tool entry breaks consecutiveness', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      note('n1'),
      tool('b', 'read', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['tool-card', 'entry', 'tool-card'])
  })
})

describe('groupThreadItems — tool streaks (legacy fold, kept)', () => {
  it(`folds completed tool cards beyond the last ${STREAK_TAIL} under a streak block`, () => {
    const blocks = groupThreadItems([
      tool('r1', 'execute', 'completed', { output: '1' }),
      tool('r2', 'execute', 'completed', { output: '2' }),
      tool('r3', 'edit', 'completed'),
      tool('r4', 'execute', 'completed', { output: '4' }),
      tool('r5', 'execute', 'completed', { output: '5' }),
    ])
    expect(shape(blocks)).toEqual(['streak', 'tool-card', 'tool-card', 'tool-card'])
    const streak = blocks[0]!
    if (streak.kind !== 'streak') throw new Error('expected a streak')
    expect(streak.count).toBe(2)
    expect(streak.blocks.map((b) => b.id)).toEqual(['r1', 'r2'])
    expect(blocks.slice(1).map((b) => b.id)).toEqual(['r3', 'r4', 'r5'])
  })

  it('exactly the tail count of cards → no fold', () => {
    const blocks = groupThreadItems([
      tool('r1', 'execute', 'completed'),
      tool('r2', 'execute', 'completed'),
      tool('r3', 'execute', 'completed'),
    ])
    expect(shape(blocks)).toEqual(['tool-card', 'tool-card', 'tool-card'])
  })

  it('a running card is never folded away — it breaks the streak, like any non-tool entry', () => {
    const blocks = groupThreadItems([
      tool('r1', 'execute', 'completed'),
      tool('r2', 'execute', 'completed'),
      tool('now', 'execute', 'running'),
      tool('r3', 'execute', 'completed'),
      tool('r4', 'execute', 'completed'),
    ])
    // No run of >3 foldable blocks exists on either side of the running card.
    expect(shape(blocks)).toEqual(['tool-card', 'tool-card', 'tool-card', 'tool-card', 'tool-card'])
  })

  it('context groups fold into streaks too, and count their member calls', () => {
    const blocks = groupThreadItems([
      tool('a', 'read', 'completed'),
      tool('b', 'read', 'completed'),
      tool('r1', 'execute', 'completed'),
      tool('r2', 'execute', 'completed'),
      tool('r3', 'execute', 'completed'),
      tool('r4', 'execute', 'completed'),
    ])
    // group(a,b) + r1 fold; r2..r4 stay as the visible tail.
    expect(shape(blocks)).toEqual(['streak', 'tool-card', 'tool-card', 'tool-card'])
    const streak = blocks[0]!
    if (streak.kind !== 'streak') throw new Error('expected a streak')
    expect(streak.count).toBe(3) // 2 grouped reads + 1 command
    expect(shape(streak.blocks)).toEqual(['context-group', 'tool-card'])
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

  it('the golden edit/write/todo turn: edit and write stay visible, the TodoWrite card does not', () => {
    const { turns } = reduceThread(asRunEvents(thinkingEditWriteTodo))
    // The reducer still carries the plan tool item (5 entries) — grouping hides it (#382):
    // the plan dock is its surface, so the thread shows only the edit/write cards.
    expect(turns[0]!.items.filter((i) => i.kind === 'tool')).toHaveLength(3)
    const blocks = groupThreadItems(turns[0]!.items)
    expect(shape(blocks)).toEqual(['entry', 'entry', 'tool-card', 'tool-card'])
    const cards = blocks.filter((b) => b.kind === 'tool-card')
    expect(cards.map((b) => (b.kind === 'tool-card' ? b.item.toolKind : ''))).toEqual(['edit', 'edit'])
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

describe('contextGroupLabel', () => {
  it.each([
    [2, 1, 'Explored 2 files · 1 search'],
    [1, 0, 'Explored 1 file'],
    [4, 0, 'Explored 4 files'],
    [0, 2, 'Explored 2 searches'],
    [0, 1, 'Explored 1 search'],
    [1, 3, 'Explored 1 file · 3 searches'],
  ])('(%i files, %i searches) → %s', (files, searches, label) => {
    expect(contextGroupLabel(files, searches)).toBe(label)
  })
})

describe('streakLabel', () => {
  it.each([
    [1, '1 earlier tool call'],
    [4, '4 earlier tool calls'],
  ])('%i → %s', (count, label) => {
    expect(streakLabel(count)).toBe(label)
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

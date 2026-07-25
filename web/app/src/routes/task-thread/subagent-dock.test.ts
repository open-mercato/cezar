import { describe, expect, it } from 'vitest'

import type { ToolStatus, UiToolItem } from '@/protocol/ui-events'

import {
  activeSubagent,
  collectSubagents,
  findSubagent,
  subagentActivityText,
  subagentChildren,
  subagentCounts,
} from './subagent-dock'
import type { ThreadEntry, ThreadTurn } from './thread-state'

/** A `Task` spawn in the shape the claude mapper emits (title precomputed by `toolDisplay`). */
const task = (id: string, status: ToolStatus, extra: Partial<UiToolItem> = {}): UiToolItem => ({
  kind: 'tool',
  id,
  name: 'Task',
  toolKind: 'task',
  title: `Task: review ${id}`,
  status,
  ...extra,
})

const childTool = (id: string, parentItemId: string, title: string): UiToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  toolKind: 'execute',
  title,
  status: 'completed',
  parentItemId,
})

const childText = (id: string, parentItemId: string, text: string): ThreadEntry => ({
  kind: 'message',
  id,
  role: 'assistant',
  text,
  parentItemId,
})

const turn = (id: string, items: ThreadEntry[]): ThreadTurn => ({ id, items })

describe('collectSubagents — which items become rows', () => {
  it('collects parent-less task items in stream order', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'running'), task('b', 'running')])])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b'])
    // "Task: review a" → the detail half; the verb is the card's, not the row's.
    expect(agents[0]!.title).toBe('review a')
  })

  it('excludes nested task items — a sub-agent spawning its own sub-agent is not a dock row', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), task('nested', 'running', { parentItemId: 'a' })]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a'])
    // The nested spawn still counts as its parent's tool call.
    expect(agents[0]!.toolCalls).toBe(1)
  })

  it('returns [] for a turn with no task items', () => {
    const read: UiToolItem = {
      kind: 'tool',
      id: 'r',
      name: 'Read',
      toolKind: 'read',
      title: 'Read /repo/a.ts',
      status: 'completed',
    }
    expect(collectSubagents([turn('turn-1', [read])])).toEqual([])
  })

  it('returns [] for no turns at all', () => {
    expect(collectSubagents([])).toEqual([])
  })

  it('anchors on the MOST RECENT turn holding task items', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('old', 'completed')]),
      turn('turn-2', [task('new', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['new'])
  })
})

describe('collectSubagents — Q6 visibility', () => {
  it('hides a settled fan-out once a newer turn exists', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'failed')]),
      turn('turn-2', [childText('m', 'nobody', 'a later assistant message')]),
    ])
    expect(agents).toEqual([])
  })

  it('keeps the dock through mid-run steering while any agent is unsettled', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running')]),
      turn('turn-2', []), // the steering message opened a new turn
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b'])
  })

  // The bug this pins: anchoring on the newest turn ALONE dropped still-running agents the
  // moment the main agent spawned one more Task in a later turn.
  it('keeps still-running agents from an earlier turn when a later turn spawns another', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), task('b', 'running')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b', 'c'])
    expect(subagentCounts(agents)).toEqual({ done: 0, total: 3 })
  })

  it('drops a fully SETTLED earlier fan-out once a later turn owns the dock', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['c'])
  })

  // Carry-over is per TURN, not per item. Filtering to just the unsettled items made a row
  // vanish the moment it finished and the denominator count DOWN — so a fan-out could never
  // read N/N, and a failed agent lost its glyph instead of keeping it.
  it('keeps a carried-over agent visible AFTER it settles, so the odometer only grows', () => {
    const running = collectSubagents([
      turn('turn-1', [task('a', 'running'), task('b', 'running')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(subagentCounts(running)).toEqual({ done: 0, total: 3 })

    // `a` finishes — the row stays, and the odometer goes UP, not down.
    const oneDone = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(oneDone.map((agent) => agent.id)).toEqual(['a', 'b', 'c'])
    expect(subagentCounts(oneDone)).toEqual({ done: 1, total: 3 })
  })

  it('keeps a FAILED carried-over agent on the board rather than hiding the failure', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'failed'), task('b', 'running')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b', 'c'])
    expect(subagentCounts(agents)).toEqual({ done: 0, total: 3 })
  })

  // A stranded agent (overlapping opencode subtasks can leave one `running` forever) must not
  // follow the user around for the rest of the session, pinning the dock open and hijacking
  // the collapsed head with its stale activity.
  // Documented re-scope, pinned so it stays a decision: the odometer is monotonic WITHIN a
  // fan-out episode, and steps back at the turn boundary when the earlier fan-out becomes
  // history in full. `1/3` → `0/1` is intended; `1/3` → `0/2` mid-flight was the round-2 bug.
  it('re-scopes to the current fan-out once the carried turn settles in full', () => {
    const partway = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(subagentCounts(partway)).toEqual({ done: 1, total: 3 })

    const settled = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'completed')]),
      turn('turn-2', [task('c', 'running')]),
    ])
    expect(settled.map((agent) => agent.id)).toEqual(['c'])
    expect(subagentCounts(settled)).toEqual({ done: 0, total: 1 })
  })

  it('does not resurrect a zombie from before the last finished fan-out', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('zombie', 'running')]),
      turn('turn-2', [task('old', 'completed')]), // a finished fan-out bounds the lookback
      turn('turn-3', [task('now', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['now'])
  })

  it('looks past a steering turn that carries no agents at all', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running')]),
      turn('turn-2', []), // the user steered; no fan-out here
      turn('turn-3', [task('b', 'running')]),
    ])
    expect(agents.map((agent) => agent.id)).toEqual(['a', 'b'])
  })

  it('still counts a carried-over agent’s children recorded in its ORIGINAL turn', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test')]),
      turn('turn-2', [task('b', 'running')]),
    ])
    expect(agents.find((agent) => agent.id === 'a')!.toolCalls).toBe(1)
  })

  it('shows a fully settled fan-out while it is still the latest turn', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'completed')])])
    expect(agents).toHaveLength(1)
  })
})

describe('collectSubagents — a terminal run', () => {
  // Nothing in the reducer settles in-flight items on session end, so a cancelled run keeps
  // `running` in its persisted stream forever. Reopening it must not pulse "0/1" for good.
  it('marks agents left in flight as stalled instead of pretending they are live', () => {
    const turns = [turn('turn-1', [task('a', 'running'), task('b', 'completed')])]
    const [stalled, done] = collectSubagents(turns, true)
    expect(stalled!.stalled).toBe(true)
    // The wire status is NOT rewritten — that would fabricate an outcome nobody reported.
    expect(stalled!.status).toBe('running')
    expect(done!.stalled).toBeUndefined()
  })

  it('lets a stalled fan-out yield to the transcript once a newer turn exists', () => {
    const turns = [
      turn('turn-1', [task('a', 'running')]),
      turn('turn-2', [childText('m', 'nobody', 'later')]),
    ]
    expect(collectSubagents(turns)).toHaveLength(1) // live run: the dock holds
    expect(collectSubagents(turns, true)).toEqual([]) // terminal run: it lets go
  })

  it('never carries a stalled agent forward into a later fan-out', () => {
    const turns = [
      turn('turn-1', [task('a', 'running')]),
      turn('turn-2', [task('b', 'running')]),
    ]
    expect(collectSubagents(turns, true).map((agent) => agent.id)).toEqual(['b'])
  })

  it('reports the same stalled flag through findSubagent, so the sheet agrees with the row', () => {
    const turns = [turn('turn-1', [task('a', 'running')])]
    expect(findSubagent(turns, 'a', true)!.stalled).toBe(true)
    expect(findSubagent(turns, 'a', false)!.stalled).toBeUndefined()
  })
})

describe('collectSubagents — children', () => {
  it('counts tool children across LATER turns (the steering scenario)', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test')]),
      turn('turn-2', [childTool('c2', 'a', 'Ran npm run build')]),
    ])
    expect(agents[0]!.toolCalls).toBe(2)
    expect(agents[0]!.activity).toBe('Ran npm run build')
  })

  it('ignores an orphaned parentItemId, exactly as the thread renders it top-level', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'ghost', 'Ran npm test')]),
    ])
    expect(agents[0]!.toolCalls).toBe(0)
    expect(agents[0]!.activity).toBeUndefined()
  })

  it('never treats a self-referential parentItemId as its own child', () => {
    // A malformed item naming itself as parent must not become its own child in the sheet.
    const selfRef: UiToolItem = {
      kind: 'tool',
      id: 'a',
      name: 'Task',
      toolKind: 'task',
      title: 'Task: review a',
      status: 'running',
    }
    const turns = [turn('turn-1', [selfRef, { ...selfRef, id: 'a', parentItemId: 'a' } as UiToolItem])]
    expect(subagentChildren(turns, 'a')).toEqual([])
  })

  it('excludes a sub-agent’s plan (TodoWrite) tool, matching what its Task card shows', () => {
    const plan: UiToolItem = {
      kind: 'tool',
      id: 'p1',
      name: 'TodoWrite',
      toolKind: 'plan',
      title: 'Task list',
      status: 'completed',
      parentItemId: 'a',
    }
    const turns = [turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test'), plan])]
    // groupThreadItems drops plan-kind tools from the thread AND from children lists (#382),
    // so counting one here would make the row disagree with its own card.
    expect(collectSubagents(turns)[0]!.toolCalls).toBe(1)
    expect(collectSubagents(turns)[0]!.activity).toBe('Ran npm test')
    expect(subagentChildren(turns, 'a').map((c) => c.id)).toEqual(['c1'])
  })

  it('leaves activity undefined when the agent has no children yet', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'running')])])
    expect(agents[0]!.activity).toBeUndefined()
  })
})

describe('collectSubagents — activity line', () => {
  it('uses a tool child title verbatim', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test')]),
    ])
    expect(agents[0]!.activity).toBe('Ran npm test')
  })

  it('uses the LAST non-empty line of a text child', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childText('c1', 'a', 'first line\nsecond line\n\n')]),
    ])
    expect(agents[0]!.activity).toBe('second line')
  })

  it('truncates a long line to a single ellipsised readout', () => {
    const long = 'x'.repeat(400)
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childText('c1', 'a', long)]),
    ])
    expect(agents[0]!.activity).toHaveLength(120)
    expect(agents[0]!.activity!.endsWith('…')).toBe(true)
  })

  it('falls back to an older child when the newest one carries no line', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running'), childTool('c1', 'a', 'Ran npm test'), childText('c2', 'a', '   ')]),
    ])
    expect(agents[0]!.activity).toBe('Ran npm test')
  })
})

describe('collectSubagents — agentType', () => {
  it.each([
    ['subagent_type', 'code-reviewer'],
    ['subagentType', 'explorer'],
    ['agent', 'build'],
  ])('reads %s from the spawn input', (key, value) => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'running', { input: { [key]: value } })]),
    ])
    expect(agents[0]!.agentType).toBe(value)
  })

  it('is undefined when the input carries no type (codex) or a non-string one', () => {
    expect(collectSubagents([turn('turn-1', [task('a', 'running')])])[0]!.agentType).toBeUndefined()
    expect(
      collectSubagents([turn('turn-1', [task('a', 'running', { input: { subagent_type: 42 } })])])[0]!.agentType,
    ).toBeUndefined()
    expect(
      collectSubagents([turn('turn-1', [task('a', 'running', { input: 'not-an-object' })])])[0]!.agentType,
    ).toBeUndefined()
  })
})

describe('subagentCounts', () => {
  it('counts completed over all agents', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running'), task('c', 'completed')]),
    ])
    expect(subagentCounts(agents)).toEqual({ done: 2, total: 3 })
  })

  it('keeps a failed agent in the denominator but never in the numerator', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'completed'), task('b', 'failed')])])
    expect(subagentCounts(agents)).toEqual({ done: 1, total: 2 })
  })

  it('is 0/0 for no agents', () => {
    expect(subagentCounts([])).toEqual({ done: 0, total: 0 })
  })
})

describe('activeSubagent', () => {
  it('names the first still-working agent', () => {
    const agents = collectSubagents([
      turn('turn-1', [task('a', 'completed'), task('b', 'running'), task('c', 'pending')]),
    ])
    expect(activeSubagent(agents)!.id).toBe('b')
  })

  it('falls back to the first row when every agent settled', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'completed'), task('b', 'completed')])])
    expect(activeSubagent(agents)!.id).toBe('a')
  })

  it('is undefined with no agents', () => {
    expect(activeSubagent([])).toBeUndefined()
  })

  // The head and the expanded row must never tell different stories about one agent: the row
  // said "never finished" while the head fell back to the title. Both now read one helper.
  it('reads a stalled agent the same way its own row does', () => {
    const agents = collectSubagents([turn('turn-1', [task('a', 'running')])], true)
    const active = activeSubagent(agents)!
    expect(active.id).toBe('a')
    expect(active.stalled).toBe(true)
    expect(subagentActivityText(active)).toBe('never finished')
  })

  it('prefers a real activity line over either placeholder', () => {
    expect(subagentActivityText({ id: 'a', title: 't', status: 'running', toolCalls: 1, activity: 'Ran npm test' })).toBe(
      'Ran npm test',
    )
    expect(subagentActivityText({ id: 'a', title: 't', status: 'running', toolCalls: 0 })).toBe('starting…')
  })
})

describe('findSubagent — the sheet outlives the dock', () => {
  // The bug this pins: resolving the open agent from `collectSubagents` meant that sending a
  // message while a drill-down was open hid the dock (Q6) AND slammed the sheet shut.
  it('still resolves an agent after the dock has yielded to the transcript', () => {
    const turns = [
      turn('turn-1', [task('a', 'completed'), childTool('c1', 'a', 'Ran npm test')]),
      turn('turn-2', [childText('m', 'nobody', 'a later assistant message')]),
    ]
    expect(collectSubagents(turns)).toEqual([]) // the dock is gone…
    expect(findSubagent(turns, 'a')).toMatchObject({ id: 'a', status: 'completed', toolCalls: 1 })
  })

  it('reports the same summary the dock row shows while both are visible', () => {
    const turns = [
      turn('turn-1', [
        task('a', 'running', { input: { subagent_type: 'reviewer' } }),
        childTool('c1', 'a', 'Ran npm test'),
      ]),
    ]
    const [row] = collectSubagents(turns)
    const found = findSubagent(turns, 'a')!
    expect(found.id).toBe(row!.id)
    expect(found.title).toBe(row!.title)
    expect(found.status).toBe(row!.status)
    expect(found.toolCalls).toBe(row!.toolCalls)
    expect(found.agentType).toBe(row!.agentType)
    // Built by the SAME summarizer, so the sheet cannot silently lose the activity line.
    expect(found.activity).toBe(row!.activity)
    expect(found.activity).toBe('Ran npm test')
  })

  it('is undefined for an unknown id and for a NESTED task item', () => {
    const turns = [turn('turn-1', [task('a', 'running'), task('nested', 'running', { parentItemId: 'a' })])]
    expect(findSubagent(turns, 'ghost')).toBeUndefined()
    expect(findSubagent(turns, 'nested')).toBeUndefined()
  })
})

describe('subagentChildren', () => {
  it('returns one agent’s children in stream order, across later turns', () => {
    const turns = [
      turn('turn-1', [task('a', 'running'), task('b', 'running'), childTool('c1', 'a', 'Ran one')]),
      turn('turn-2', [childTool('c2', 'b', 'Ran other'), childTool('c3', 'a', 'Ran two')]),
    ]
    expect(subagentChildren(turns, 'a').map((child) => child.id)).toEqual(['c1', 'c3'])
    expect(subagentChildren(turns, 'b').map((child) => child.id)).toEqual(['c2'])
  })

  it('is empty for an unknown or childless parent', () => {
    const turns = [turn('turn-1', [task('a', 'running')])]
    expect(subagentChildren(turns, 'a')).toEqual([])
    expect(subagentChildren(turns, 'ghost')).toEqual([])
  })
})

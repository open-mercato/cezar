import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'

import subagentTask from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import { collectSubagents, subagentChildren } from './subagent-dock'
import { SubagentSheet } from './subagent-sheet'
import { reduceThread } from './thread-state'

/**
 * Finished-run parity (spec §"Drill-down sheet", Step 2.2, #474): a reloaded run replays its
 * persisted events through the SAME reducer a live run uses, so the dock and the sheet must
 * show the same thing they showed while it was running.
 *
 * Driven from the golden claude fixture rather than hand-built turns — that is the exact
 * event shape the mapper is pinned to, so this test fails if the wire contract drifts.
 */

afterEach(cleanup)

/** Golden fixtures are `UiEvent[]` — stamp the wire's seq/ts on them, as the store does. */
const asRunEvents = (events: object[]): RunEvent[] =>
  events.map((event, index) => ({ seq: index + 1, ts: '2026-07-14T12:00:00.000Z', ...event }) as RunEvent)

const REPLAYED = reduceThread(asRunEvents(subagentTask as object[]))

describe('replayed run — the dock', () => {
  it('rebuilds the fan-out from persisted events alone', () => {
    const agents = collectSubagents(REPLAYED.turns)
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: 'toolu_task_01',
      title: 'Audit auth flow',
      agentType: 'general-purpose',
      status: 'completed',
      // The `Search session` tool child; the message child is not a tool call.
      toolCalls: 1,
    })
  })

  it('carries an activity line from the last persisted child, not from live deltas', () => {
    // `item.delta` frames are live-only and never persisted (`ui-event-sink.ts`), so after a
    // reload the activity falls back to the last child SNAPSHOT — documented, not a bug.
    expect(collectSubagents(REPLAYED.turns)[0]!.activity).toBe('Search session')
  })
})

describe('replayed run — the sheet', () => {
  it('shows each agent’s children in stream order, matching the fixture', () => {
    const agents = collectSubagents(REPLAYED.turns)
    for (const agent of agents) {
      const children = subagentChildren(REPLAYED.turns, agent.id)
      // Exactly the fixture's parented items, deduplicated by the reducer's id-keyed upsert.
      expect(children.map((child) => child.id)).toEqual(['item_1', 'toolu_sub_01'])

      const { unmount } = render(
        <SubagentSheet runId="r1" agent={agent} entries={children} onClose={() => {}} />,
      )
      const stream = document.querySelector('[data-slot="subagent-stream"]')!
      expect(stream.textContent).toContain('Scanning the auth middleware.')
      expect(stream.textContent).toContain('session') // "Search session", split verb/detail
      // The sheet shows the settled state, not a perpetually-running one.
      expect(document.querySelector('[data-slot="subagent-status"]')!.textContent).toBe('Completed')
      unmount()
    }
  })

  it('never shows the main turn’s own output inside an agent', () => {
    const children = subagentChildren(REPLAYED.turns, 'toolu_task_01')
    // `item_2` is the assistant's summary AFTER the sub-agent returned — parent-less, and so
    // the transcript's, not the agent's.
    expect(children.map((child) => child.id)).not.toContain('item_2')
  })
})

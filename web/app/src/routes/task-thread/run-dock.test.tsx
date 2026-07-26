import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PlanEntry } from '@/protocol/ui-events'

import thinkingEditWriteTodo from '../../../../../src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import { planActiveEntry, planCounts, RunDock } from './run-dock'
import type { SubagentSummary } from './subagent-dock'

afterEach(cleanup)

/** The golden claude `plan.updated` snapshot (thinking-edit-write-todo) — the exact entry
 *  shapes the R2 mapper is pinned to: completed / in_progress / pending, each with an
 *  `activeForm`. Never hand-invented. */
const GOLDEN: PlanEntry[] = (thinkingEditWriteTodo as Array<{ type: string; entries?: PlanEntry[] }>).find(
  (event) => event.type === 'plan.updated',
)!.entries!

const agent = (over: Partial<SubagentSummary> = {}): SubagentSummary => ({
  id: 'a',
  title: 'Audit the auth flow',
  status: 'running',
  toolCalls: 0,
  ...over,
})

/** The collapse map is module-level BY DESIGN (the choice must survive route changes), so
 *  every test that toggles needs its own run id or it inherits the previous test's state. */
let runSeq = 0
const freshRun = () => `run-${(runSeq += 1)}`

const dock = () => document.querySelector('[data-slot="run-dock"]')
const toggle = () => document.querySelector<HTMLButtonElement>('[data-slot="run-dock-toggle"]')!
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="run-dock-tab"]')]
const planRows = () => [...document.querySelectorAll('[data-slot="plan-item"]')]
const agentRows = () => [...document.querySelectorAll('[data-slot="agent-item"]')]
const glyph = (row: Element) => row.querySelector('[data-slot="agent-glyph"]')!

describe('planCounts / planActiveEntry — the odometer math', () => {
  it('counts completed over total (the golden snapshot is 1/3)', () => {
    expect(planCounts(GOLDEN)).toEqual({ done: 1, total: 3 })
  })

  // opencode's `cancelled` — work dropped on purpose. Counting it would strand the
  // odometer below N/N for the rest of the run.
  it('leaves cancelled entries out of the denominator, so a plan can still read done', () => {
    expect(
      planCounts([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'cancelled' },
      ]),
    ).toEqual({ done: 2, total: 2 })
  })

  it('an all-cancelled plan is 0/0, not a division by the dropped work', () => {
    expect(planCounts([{ content: 'a', status: 'cancelled' }])).toEqual({ done: 0, total: 0 })
  })

  it.each<[string, PlanEntry[], string | undefined]>([
    ['the in-progress entry wins', GOLDEN, 'Run tests'],
    [
      'no in-progress → the next pending one',
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
      'b',
    ],
    ['fully completed → none', [{ content: 'a', status: 'completed' }], undefined],
    [
      'cancelled is never the current item — it skips to the next real pending one',
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'cancelled' },
        { content: 'c', status: 'pending' },
      ],
      'c',
    ],
    ['nothing left but cancelled → none', [{ content: 'a', status: 'cancelled' }], undefined],
  ])('%s', (_name, entries, expected) => {
    expect(planActiveEntry(entries)?.content).toBe(expected)
  })
})

describe('RunDock — visibility and the collapsed default', () => {
  it('renders nothing with neither a plan nor a fan-out', () => {
    render(<RunDock runId={freshRun()} plan={[]} agents={[]} />)
    expect(dock()).toBeNull()
  })

  it('mounts collapsed by default on every breakpoint, with the ONE gradient strip on top', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[]} />)
    expect(dock()!.getAttribute('data-state')).toBe('collapsed')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-slot="grad-edge"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="plan-list"]')).toBeNull()
  })

  it('collapsed, the head reads the odometer and the current item (activeForm first)', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[]} />)
    expect(document.querySelector('[data-slot="plan-count"]')!.textContent).toBe('1/3')
    expect(document.querySelector('[data-slot="run-dock-current"]')!.textContent).toBe('— Running tests')
  })

  it('falls back to the entry content when the current item has no activeForm', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={[
          { content: 'Ship it', status: 'in_progress' },
          { content: 'Later', status: 'pending' },
        ]}
        agents={[]}
      />,
    )
    expect(document.querySelector('[data-slot="run-dock-current"]')!.textContent).toBe('— Ship it')
  })

  it('toggles open/collapsed and reports it to assistive tech; open lists scroll in max-h-64', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[]} />)
    fireEvent.click(toggle())
    expect(dock()!.getAttribute('data-state')).toBe('open')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const list = document.querySelector('[data-slot="plan-list"]')!
    expect(list.className).toContain('max-h-64')
    // Open: the current-item line belongs to the collapsed head only.
    expect(document.querySelector('[data-slot="run-dock-current"]')).toBeNull()
    fireEvent.click(toggle())
    expect(dock()!.getAttribute('data-state')).toBe('collapsed')
  })

  it('remembers the collapse per run id across unmounts (the module-level cache)', () => {
    const { unmount } = render(<RunDock runId="dock-memory" plan={GOLDEN} agents={[]} />)
    fireEvent.click(toggle())
    expect(dock()!.getAttribute('data-state')).toBe('open')
    unmount()

    // Same run: reopens open. Another run: fresh default (collapsed).
    const second = render(<RunDock runId="dock-memory" plan={GOLDEN} agents={[]} />)
    expect(dock()!.getAttribute('data-state')).toBe('open')
    second.unmount()
    render(<RunDock runId="dock-memory-other" plan={GOLDEN} agents={[]} />)
    expect(dock()!.getAttribute('data-state')).toBe('collapsed')
  })
})

describe('RunDock — the Plan tab', () => {
  it('renders the three row states; the in-progress row keeps sr-only text, not a pill', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[]} />)
    fireEvent.click(toggle())

    const rows = planRows()
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows[0]!.textContent).toBe('Patch middleware redirect')
    expect(rows[0]!.className).toContain('line-through')
    // The pulsing glyph + weight carry "in progress"; the words are for screen readers only.
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')).toBeNull()
    const srOnly = rows[1]!.querySelector('.sr-only')
    expect(srOnly?.textContent).toBe('in progress')
    expect(rows[1]!.querySelector('svg')?.getAttribute('class')).toContain('animate-pulse')
    expect(rows[2]!.textContent).toBe('Update changelog')
  })

  // Regression: an opencode `cancelled` todo used to be dropped by the mapper and
  // never reached the dock at all. It must render — struck through, out of the score.
  it('renders a cancelled row struck through and keeps it out of the odometer', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={[
          { content: 'Ship the fix', status: 'completed' },
          { content: 'Rework the parser', status: 'cancelled' },
        ]}
        agents={[]}
      />,
    )
    expect(document.querySelector('[data-slot="plan-count"]')!.textContent).toBe('1/1')
    fireEvent.click(toggle())

    const rows = planRows()
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'cancelled'])
    expect(rows[1]!.className).toContain('line-through')

    // Pin the ⊘ by its own slash path: asserting only "not animate-pulse" would
    // also pass for the pending ○, i.e. it would survive deleting the glyph.
    const cancelledIcon = rows[1]!.querySelector('svg')!
    expect(cancelledIcon.querySelector('path')?.getAttribute('d')).toBe('m8.5 15.5 7-7')
    expect(cancelledIcon.getAttribute('class')).not.toContain('animate-pulse')
  })
})

describe('RunDock — the Agents tab', () => {
  it('reads the odometer in the head and defaults to the Agents tab while a fan-out exists', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={GOLDEN}
        agents={[agent({ id: 'a', status: 'completed' }), agent({ id: 'b', status: 'completed' })]}
      />,
    )
    expect(document.querySelector('[data-slot="agents-count"]')!.textContent).toBe('2/2')
    fireEvent.click(toggle())
    expect(agentRows()).toHaveLength(2)
    expect(planRows()).toHaveLength(0)
  })

  it('keeps a failed agent out of the numerator but in the denominator', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={[]}
        agents={[agent({ id: 'a', status: 'completed' }), agent({ id: 'b', status: 'failed' })]}
      />,
    )
    expect(document.querySelector('[data-slot="agents-count"]')!.textContent).toBe('1/2')
  })

  it('collapsed, the head names the first working agent’s activity', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={[]}
        agents={[
          agent({ id: 'a', status: 'completed' }),
          agent({ id: 'b', status: 'running', activity: 'Reviewing store layer' }),
        ]}
      />,
    )
    expect(document.querySelector('[data-slot="run-dock-current"]')!.textContent).toBe('— Reviewing store layer')
  })

  it('shows title, type chip, activity and tool count, in stream order', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={[]}
        agents={[
          agent({ id: 'a', title: 'Audit the auth flow', agentType: 'general-purpose', activity: 'Ran npm test', toolCalls: 3 }),
          agent({ id: 'b', title: 'Review the store layer', status: 'completed', toolCalls: 1 }),
        ]}
      />,
    )
    fireEvent.click(toggle())
    const [first, second] = agentRows()
    expect(first!.textContent).toContain('Audit the auth flow')
    expect(first!.querySelector('[data-slot="agent-type"]')!.textContent).toBe('general-purpose')
    expect(first!.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('Ran npm test')
    expect(first!.querySelector('[data-slot="agent-tools"]')!.textContent).toBe('3 tools')
    // Singular, because "1 tools" is the kind of detail that makes a UI feel unfinished.
    expect(second!.querySelector('[data-slot="agent-tools"]')!.textContent).toBe('1 tool')
    expect(second!.textContent).toContain('Review the store layer')
  })

  it('renders "starting…" for an agent with no attributed output yet, and no chip without a type', () => {
    render(<RunDock runId={freshRun()} plan={[]} agents={[agent({ activity: undefined, agentType: undefined })]} />)
    fireEvent.click(toggle())
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('starting…')
    expect(document.querySelector('[data-slot="agent-type"]')).toBeNull()
  })

  it('distinguishes status by GLYPH SHAPE, never by color alone', () => {
    render(
      <RunDock
        runId={freshRun()}
        plan={[]}
        agents={[
          agent({ id: 'a', status: 'running' }),
          agent({ id: 'b', status: 'completed' }),
          agent({ id: 'c', status: 'failed' }),
        ]}
      />,
    )
    fireEvent.click(toggle())
    const [running, completed, failed] = agentRows().map(glyph)
    // The running glyph is the pulsing half-disc; the other two are stroked paths.
    expect(running!.querySelector('.fill-pending')).not.toBeNull()
    expect(running!.classList.contains('animate-pulse')).toBe(true)
    // Reduced motion must silence the pulse.
    expect(running!.classList.contains('motion-reduce:animate-none')).toBe(true)
    expect(completed!.classList.contains('text-success')).toBe(true)
    expect(failed!.classList.contains('text-danger')).toBe(true)
    // Shapes differ, so the three are told apart without perceiving hue at all.
    const path = (svg: Element) => svg.querySelector('path')!.getAttribute('d')
    expect(new Set([path(running!), path(completed!), path(failed!)]).size).toBe(3)
  })

  it('renders a stalled agent as interrupted — not pulsing, not a checkmark', () => {
    render(<RunDock runId={freshRun()} plan={[]} agents={[agent({ status: 'running', stalled: true })]} />)
    fireEvent.click(toggle())
    const svg = glyph(agentRows()[0]!)
    expect(svg.getAttribute('data-stalled')).toBe('true')
    // Not the live glyph: no pulse, no amber fill — the run ended, nothing is working.
    expect(svg.classList.contains('animate-pulse')).toBe(false)
    expect(svg.querySelector('.fill-pending')).toBeNull()
    // Not a success glyph either — it did not finish.
    expect(svg.classList.contains('text-success')).toBe(false)
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('never finished')
  })

  it('exposes each status on the row for styling and tests', () => {
    render(<RunDock runId={freshRun()} plan={[]} agents={[agent({ status: 'declined' })]} />)
    fireEvent.click(toggle())
    expect(agentRows()[0]!.getAttribute('data-status')).toBe('declined')
  })

  it('rows are static display when no handler is passed; buttons with one (the drill-down)', () => {
    const first = render(<RunDock runId={freshRun()} plan={[]} agents={[agent()]} />)
    fireEvent.click(toggle())
    expect(agentRows()[0]!.querySelector('button')).toBeNull()
    first.unmount()

    const opened: string[] = []
    render(
      <RunDock runId={freshRun()} plan={[]} agents={[agent({ id: 'agent-42' })]} onSelectAgent={(id) => opened.push(id)} />,
    )
    fireEvent.click(toggle())
    const button = agentRows()[0]!.querySelector('button')!
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(button)
    expect(opened).toEqual(['agent-42'])
  })
})

describe('RunDock — the tab row', () => {
  it('shows both tabs when both surfaces exist; a tab click opens its list', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[agent()]} />)
    const [planTab, agentsTab] = tabs()
    expect(planTab!.textContent).toContain('Plan')
    expect(agentsTab!.textContent).toContain('Agents')

    fireEvent.click(planTab!)
    expect(dock()!.getAttribute('data-state')).toBe('open')
    expect(planRows().length).toBeGreaterThan(0)
    expect(planTab!.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(agentsTab!)
    expect(agentRows()).toHaveLength(1)
    expect(planRows()).toHaveLength(0)
  })

  it('clicking the active tab collapses the dock again', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[]} />)
    const [planTab] = tabs()
    fireEvent.click(planTab!)
    expect(dock()!.getAttribute('data-state')).toBe('open')
    fireEvent.click(planTab!)
    expect(dock()!.getAttribute('data-state')).toBe('collapsed')
  })

  it('hides the Agents tab entirely when there is no fan-out', () => {
    render(<RunDock runId={freshRun()} plan={GOLDEN} agents={[]} />)
    expect(tabs()).toHaveLength(1)
    expect(document.querySelector('[data-slot="agents-count"]')).toBeNull()
  })

  it('falls back to the Plan tab when the picked Agents tab loses its content', () => {
    const runId = freshRun()
    const { rerender } = render(<RunDock runId={runId} plan={GOLDEN} agents={[agent()]} />)
    fireEvent.click(toggle())
    expect(agentRows()).toHaveLength(1)
    rerender(<RunDock runId={runId} plan={GOLDEN} agents={[]} />)
    expect(planRows().length).toBeGreaterThan(0)
  })
})

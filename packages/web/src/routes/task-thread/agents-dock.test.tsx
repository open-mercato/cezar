import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentsDock } from './agents-dock'
import type { SubagentSummary } from './subagent-dock'

afterEach(cleanup)

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

const dock = () => document.querySelector('[data-slot="agents-dock"]')
const head = () => document.querySelector<HTMLButtonElement>('[data-slot="agents-dock"] > button')!
const rows = () => Array.from(document.querySelectorAll('[data-slot="agent-item"]'))
const glyph = (row: Element) => row.querySelector('[data-slot="agent-glyph"]')!

describe('AgentsDock — visibility', () => {
  it('renders nothing at all when there is no fan-out', () => {
    render(<AgentsDock runId={freshRun()} agents={[]} />)
    expect(dock()).toBeNull()
  })

  it('mounts once there is at least one agent', () => {
    render(<AgentsDock runId={freshRun()} agents={[agent()]} />)
    expect(dock()).not.toBeNull()
  })
})

describe('AgentsDock — the collapsed head', () => {
  it('shows the odometer and the first working agent’s activity', () => {
    render(
      <AgentsDock
        runId={freshRun()}
        agents={[
          agent({ id: 'a', status: 'completed' }),
          agent({ id: 'b', status: 'running', activity: 'Reviewing store layer' }),
          agent({ id: 'c', status: 'pending' }),
        ]}
      />,
    )
    fireEvent.click(head()) // jsdom defaults to expanded (desktop) — collapse it
    expect(document.querySelector('[data-slot="agents-count"]')!.textContent).toContain('1/3')
    expect(document.querySelector('[data-slot="agents-current"]')!.textContent).toContain('Reviewing store layer')
  })

  it('reads N/N once every agent settled', () => {
    render(
      <AgentsDock runId={freshRun()} agents={[agent({ id: 'a', status: 'completed' }), agent({ id: 'b', status: 'completed' })]} />,
    )
    expect(document.querySelector('[data-slot="agents-count"]')!.textContent).toContain('2/2')
  })

  it('keeps a failed agent out of the numerator but in the denominator', () => {
    render(
      <AgentsDock runId={freshRun()} agents={[agent({ id: 'a', status: 'completed' }), agent({ id: 'b', status: 'failed' })]} />,
    )
    expect(document.querySelector('[data-slot="agents-count"]')!.textContent).toContain('1/2')
  })

  it('toggles expanded/collapsed and reports it to assistive tech', () => {
    render(<AgentsDock runId="run-toggle" agents={[agent()]} />)
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toHaveLength(1)
    fireEvent.click(head())
    expect(head().getAttribute('aria-expanded')).toBe('false')
    expect(rows()).toHaveLength(0)
  })
})

describe('AgentsDock — expanded rows', () => {
  it('shows title, type badge, activity and tool count, in stream order', () => {
    render(
      <AgentsDock
        runId={freshRun()}
        agents={[
          agent({ id: 'a', title: 'Audit the auth flow', agentType: 'general-purpose', activity: 'Ran npm test', toolCalls: 3 }),
          agent({ id: 'b', title: 'Review the store layer', status: 'completed', toolCalls: 1 }),
        ]}
      />,
    )
    const [first, second] = rows()
    expect(first!.textContent).toContain('Audit the auth flow')
    expect(first!.querySelector('[data-slot="agent-type"]')!.textContent).toBe('general-purpose')
    expect(first!.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('Ran npm test')
    expect(first!.querySelector('[data-slot="agent-tools"]')!.textContent).toBe('3 tools')
    // Singular, because "1 tools" is the kind of detail that makes a UI feel unfinished.
    expect(second!.querySelector('[data-slot="agent-tools"]')!.textContent).toBe('1 tool')
    expect(second!.textContent).toContain('Review the store layer')
  })

  it('renders "starting…" for an agent with no attributed output yet', () => {
    render(<AgentsDock runId={freshRun()} agents={[agent({ activity: undefined })]} />)
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('starting…')
  })

  it('omits the type badge when the backend declares none (codex)', () => {
    render(<AgentsDock runId={freshRun()} agents={[agent({ agentType: undefined })]} />)
    expect(document.querySelector('[data-slot="agent-type"]')).toBeNull()
  })

  it('distinguishes status by GLYPH SHAPE, never by color alone', () => {
    render(
      <AgentsDock
        runId={freshRun()}
        agents={[
          agent({ id: 'a', status: 'running' }),
          agent({ id: 'b', status: 'completed' }),
          agent({ id: 'c', status: 'failed' }),
        ]}
      />,
    )
    const [running, completed, failed] = rows().map(glyph)
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
    render(<AgentsDock runId={freshRun()} agents={[agent({ status: 'running', stalled: true })]} />)
    const svg = glyph(rows()[0]!)
    expect(svg.getAttribute('data-stalled')).toBe('true')
    // Not the live glyph: no pulse, no amber fill — the run ended, nothing is working.
    expect(svg.classList.contains('animate-pulse')).toBe(false)
    expect(svg.querySelector('.fill-pending')).toBeNull()
    // Not a success glyph either — it did not finish.
    expect(svg.classList.contains('text-success')).toBe(false)
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('never finished')
  })

  it('keeps a stalled agent’s real activity line when it produced one', () => {
    render(
      <AgentsDock runId={freshRun()} agents={[agent({ status: 'running', stalled: true, activity: 'Ran npm test' })]} />,
    )
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('Ran npm test')
  })

  it('exposes each status on the row for styling and tests', () => {
    render(<AgentsDock runId={freshRun()} agents={[agent({ status: 'declined' })]} />)
    expect(rows()[0]!.getAttribute('data-status')).toBe('declined')
  })
})

describe('AgentsDock — row interaction', () => {
  it('rows are static display when no handler is passed (Phase 1)', () => {
    render(<AgentsDock runId={freshRun()} agents={[agent()]} />)
    expect(rows()[0]!.querySelector('button')).toBeNull()
  })

  it('rows become dialog-opening buttons once a handler is passed (Phase 2)', () => {
    const opened: string[] = []
    render(<AgentsDock runId={freshRun()} agents={[agent({ id: 'agent-42' })]} onSelect={(id) => opened.push(id)} />)
    const button = rows()[0]!.querySelector('button')!
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(button)
    expect(opened).toEqual(['agent-42'])
  })
})

describe('AgentsDock — collapse memory', () => {
  it('remembers the collapse choice per run across remounts', () => {
    const { unmount } = render(<AgentsDock runId="run-memory" agents={[agent()]} />)
    fireEvent.click(head()) // collapse
    unmount()
    render(<AgentsDock runId="run-memory" agents={[agent()]} />)
    expect(head().getAttribute('aria-expanded')).toBe('false')
  })

  it('does not leak that choice to a different run', () => {
    render(<AgentsDock runId="run-other" agents={[agent()]} />)
    expect(head().getAttribute('aria-expanded')).toBe('true')
  })
})

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { UiToolItem } from '@open-mercato/cezar-api-client'

import { SubagentSheet } from './subagent-sheet'
import type { SubagentSummary } from './subagent-dock'
import type { ThreadEntry } from './thread-state'

afterEach(cleanup)

const agent = (over: Partial<SubagentSummary> = {}): SubagentSummary => ({
  id: 'agent-1',
  title: 'Audit the auth flow',
  status: 'running',
  toolCalls: 2,
  ...over,
})

const toolChild = (id: string, title: string): UiToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  toolKind: 'execute',
  title,
  status: 'completed',
  parentItemId: 'agent-1',
})

const textChild = (id: string, text: string): ThreadEntry => ({
  kind: 'message',
  id,
  role: 'assistant',
  text,
  parentItemId: 'agent-1',
})

const sheet = () => document.querySelector('[data-slot="subagent-sheet"]')
const stream = () => document.querySelector('[data-slot="subagent-stream"]')

describe('SubagentSheet — open/close', () => {
  it('renders nothing while no agent is selected', () => {
    render(<SubagentSheet runId="r1" agent={undefined} entries={[]} onClose={() => {}} />)
    expect(sheet()).toBeNull()
  })

  it('opens as a labeled dialog for the selected agent', () => {
    render(<SubagentSheet runId="r1" agent={agent()} entries={[]} onClose={() => {}} />)
    expect(sheet()).not.toBeNull()
    expect(sheet()!.getAttribute('role')).toBe('dialog')
    expect(sheet()!.textContent).toContain('Audit the auth flow')
  })

  it('asks to close on Escape', () => {
    let closed = 0
    render(<SubagentSheet runId="r1" agent={agent()} entries={[]} onClose={() => { closed += 1 }} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closed).toBe(1)
  })

  it('asks to close from the close button', () => {
    let closed = 0
    render(<SubagentSheet runId="r1" agent={agent()} entries={[]} onClose={() => { closed += 1 }} />)
    // `data-slot="subagent-sheet"` replaces the primitive's own slot name, so the sheet's
    // close button is simply the only button in an otherwise empty panel.
    fireEvent.click(document.querySelector('[data-slot="subagent-sheet"] button')!)
    expect(closed).toBe(1)
  })
})

describe('SubagentSheet — header', () => {
  it('shows the type badge, a status word and the tool-call count', () => {
    render(
      <SubagentSheet
        runId="r1"
        agent={agent({ agentType: 'general-purpose', status: 'running', toolCalls: 3 })}
        entries={[]}
        onClose={() => {}}
      />,
    )
    expect(document.querySelector('[data-slot="agent-type"]')!.textContent).toBe('general-purpose')
    // Status is a WORD, not only a hue — a glyph alone does not survive a screen reader.
    expect(document.querySelector('[data-slot="subagent-status"]')!.textContent).toBe('Running')
    expect(document.querySelector('[data-slot="subagent-meta"]')!.textContent).toContain('3 tool calls')
  })

  it('says "1 tool call", not "1 tool calls"', () => {
    render(<SubagentSheet runId="r1" agent={agent({ toolCalls: 1 })} entries={[]} onClose={() => {}} />)
    expect(document.querySelector('[data-slot="subagent-meta"]')!.textContent).toContain('1 tool call')
  })

  it('omits the type badge for a backend that declares none (codex)', () => {
    render(<SubagentSheet runId="r1" agent={agent({ agentType: undefined })} entries={[]} onClose={() => {}} />)
    expect(document.querySelector('[data-slot="agent-type"]')).toBeNull()
  })

  it.each([
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['declined', 'Declined'],
    ['pending', 'Pending'],
  ] as const)('renders %s as the word %s', (status, label) => {
    render(<SubagentSheet runId="r1" agent={agent({ status })} entries={[]} onClose={() => {}} />)
    expect(document.querySelector('[data-slot="subagent-status"]')!.textContent).toBe(label)
  })
})

describe('SubagentSheet — the child stream', () => {
  it('renders exactly that agent’s children, in stream order', () => {
    render(
      <SubagentSheet
        runId="r1"
        agent={agent()}
        entries={[textChild('c1', 'Scanning the auth middleware.'), toolChild('c2', 'Ran npm test')]}
        onClose={() => {}}
      />,
    )
    const text = stream()!.textContent!
    expect(text).toContain('Scanning the auth middleware.')
    // ToolCard renders the title as a bold verb + a mono detail, so textContent reads
    // "Rannpm test" — the detail is the identifying half, so assert on that.
    expect(text).toContain('npm test')
    expect(text.indexOf('Scanning')).toBeLessThan(text.indexOf('npm test'))
  })

  it('shows the empty state for an agent with no attributed output (a codex review row)', () => {
    render(<SubagentSheet runId="r1" agent={agent({ toolCalls: 0 })} entries={[]} onClose={() => {}} />)
    expect(stream()).not.toBeNull()
    expect(document.querySelector('[data-slot="subagent-empty"]')!.textContent).toContain(
      'No attributed output',
    )
  })

  it('renders output appended while the sheet is open', () => {
    const { rerender } = render(
      <SubagentSheet runId="r1" agent={agent()} entries={[toolChild('c1', 'Ran npm test')]} onClose={() => {}} />,
    )
    expect(stream()!.textContent).not.toContain('npm run build')
    rerender(
      <SubagentSheet
        runId="r1"
        agent={agent()}
        entries={[toolChild('c1', 'Ran npm test'), toolChild('c2', 'Ran npm run build')]}
        onClose={() => {}}
      />,
    )
    expect(stream()!.textContent).toContain('npm run build')
  })

  it('an agent completing while inspected flips the status pill and keeps the sheet open', () => {
    const entries = [toolChild('c1', 'Ran npm test')]
    const { rerender } = render(
      <SubagentSheet runId="r1" agent={agent({ status: 'running' })} entries={entries} onClose={() => {}} />,
    )
    expect(document.querySelector('[data-slot="subagent-status"]')!.textContent).toBe('Running')
    rerender(<SubagentSheet runId="r1" agent={agent({ status: 'completed' })} entries={entries} onClose={() => {}} />)
    expect(sheet()).not.toBeNull()
    expect(document.querySelector('[data-slot="subagent-status"]')!.textContent).toBe('Completed')
    expect(stream()!.textContent).toContain('npm test')
  })
})

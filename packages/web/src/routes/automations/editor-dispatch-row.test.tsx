import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditorDispatchRow } from './editor-dispatch-row'

afterEach(cleanup)

describe('EditorDispatchRow', () => {
  it('renders nothing when the cockpit has dispatch off', () => {
    const { container } = render(
      <EditorDispatchRow available={false} enabled maxSubtasks={4} reviewChild onChange={() => undefined} />,
    )
    expect(container.querySelector('[data-slot="editor-dispatch"]')).toBeNull()
  })

  it('shows only the switch while off, and the subtask controls plus the agents hint when on', () => {
    const onChange = vi.fn()
    const { rerender, container } = render(
      <EditorDispatchRow available enabled={false} maxSubtasks={4} reviewChild onChange={onChange} />,
    )
    expect(screen.queryByText(/agents/)).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Dispatch' }))
    expect(onChange).toHaveBeenCalledWith({ dispatch: true })

    rerender(<EditorDispatchRow available enabled maxSubtasks={4} reviewChild onChange={onChange} />)
    expect(container.querySelector('[data-slot="editor-dispatch"]')?.getAttribute('data-enabled')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Review child' })).not.toBeNull()
    // ≤ maxSubtasks + 1 (the parent) — the brief's hint, not the export's.
    expect(container.querySelector('[data-slot="editor-dispatch-hint"]')?.textContent).toBe('≤ 5 agents')

    rerender(<EditorDispatchRow available enabled maxSubtasks={8} reviewChild={false} onChange={onChange} />)
    expect(container.querySelector('[data-slot="editor-dispatch-hint"]')?.textContent).toBe('≤ 9 agents')
    fireEvent.click(screen.getByRole('switch', { name: 'Review child' }))
    expect(onChange).toHaveBeenLastCalledWith({ reviewChild: true })
  })
})

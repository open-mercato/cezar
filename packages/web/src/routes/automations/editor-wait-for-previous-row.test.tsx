import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditorWaitForPreviousRow } from './editor-wait-for-previous-row'

afterEach(cleanup)

describe('EditorWaitForPreviousRow', () => {
  it('is a labelled checkbox with the longer-tasks hint, reporting each toggle', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<EditorWaitForPreviousRow checked={false} onChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: /Wait for the previous execution to finish/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(container.querySelector('[data-slot="editor-wait-for-previous-hint"]')?.textContent).toMatch(/For longer tasks it is safer/)
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<EditorWaitForPreviousRow checked onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })
})

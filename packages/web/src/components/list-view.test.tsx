import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ListViewProvider, useListView } from '@/components/list-view'

afterEach(cleanup)

/** Two consumers in two subtrees — the sidebar and the table's shapes. */
function Consumer({ name }: { name: string }) {
  const [view, setView] = useListView()
  return (
    <button type="button" onClick={() => setView(view === 'active' ? 'archived' : 'active')}>
      {name}:{view}
    </button>
  )
}

describe('ListViewProvider', () => {
  it('starts on Active', () => {
    render(
      <ListViewProvider>
        <Consumer name="a" />
      </ListViewProvider>
    )
    expect((screen.getByRole('button'))?.textContent).toContain('a:active')
  })

  it('keeps every consumer on the same view — the sidebar and the table cannot disagree', async () => {
    render(
      <ListViewProvider>
        <div>
          <Consumer name="sidebar" />
        </div>
        <div>
          <Consumer name="table" />
        </div>
      </ListViewProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'sidebar:active' }))
    expect(screen.getByRole('button', { name: 'sidebar:archived' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'table:archived' })).not.toBeNull()

    // …and back, from the other one.
    fireEvent.click(screen.getByRole('button', { name: 'table:archived' }))
    expect(screen.getByRole('button', { name: 'sidebar:active' })).not.toBeNull()
  })

  it('throws outside a provider rather than handing out a private filter', () => {
    // React logs the thrown render error; the assertion is the throw itself.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<Consumer name="orphan" />)).toThrow(/must be used inside a <ListViewProvider>/)
    } finally {
      error.mockRestore()
    }
  })
})

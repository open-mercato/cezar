import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { managerFixture } from './manager-fixtures'
import { ManagerRow } from './manager-sidebar'

afterEach(cleanup)

const now = new Date(2026, 9, 31, 12, 0)

function renderRow(overrides: Parameters<typeof managerFixture>[0], active = false) {
  render(
    <MemoryRouter>
      <ManagerRow manager={managerFixture(overrides)} active={active} now={now} />
    </MemoryRouter>,
  )
  return document.querySelector('[data-slot="manager-row"]') as HTMLAnchorElement
}

describe('ManagerRow', () => {
  it('shows name, time and preview, and links to the chat', () => {
    const row = renderRow({ preview: 'Got it!', lastActivityAt: new Date(2026, 9, 31, 7, 34).toISOString() })
    expect(row.getAttribute('href')).toBe('/manager/global')
    expect(row.textContent).toContain('Global Manager')
    expect(row.textContent).toContain('Got it!')
    expect(row.textContent).toMatch(/7:34/)
    expect(row.dataset.unread).toBeUndefined()
  })

  it('swaps the time for a dot when unread, and says so to assistive tech', () => {
    const row = renderRow({ unread: 3, preview: 'x', lastActivityAt: new Date(2026, 9, 31, 7, 34).toISOString() })
    expect(row.dataset.unread).toBe('true')
    expect(row.textContent).not.toMatch(/7:34/)
    expect(row.textContent).toContain(', unread')
  })

  it('counts a pending approval as unread', () => {
    const row = renderRow({ pendingActions: 1 })
    expect(row.dataset.unread).toBe('true')
    expect(row.textContent).toContain('1 approval waiting')
  })

  it('marks the open chat', () => {
    expect(renderRow({}, true).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link').className).toContain('bg-muted')
  })
})

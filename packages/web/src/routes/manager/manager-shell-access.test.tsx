import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { managerFixture } from './manager-fixtures'
import { ShellAccessDialog } from './manager-shell-access'

afterEach(cleanup)

const denials = [
  { command: 'gh label list --limit 5', reason: '`gh label list` is not read-only', at: 'x', count: 2, suggestion: 'gh label list' },
  { command: 'gh pr merge 1', reason: '`gh pr merge` is not read-only', at: 'x', count: 1 },
]

describe('ShellAccessDialog', () => {
  it('allows a refused read-only pattern in one click, and offers nothing for a write', () => {
    const onUpdate = vi.fn(() => Promise.resolve())
    render(<ShellAccessDialog manager={managerFixture({ bashAllow: ['gh workflow view'], bashDenials: denials })} open onOpenChange={vi.fn()} onUpdate={onUpdate} />)
    expect(screen.getByText('gh pr merge 1')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Allow / })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Allow gh label list (read-only)' }))
    expect(onUpdate).toHaveBeenCalledWith({ bashAllow: ['gh workflow view', 'gh label list'] })
  })

  it('removes a pattern and clears the log', async () => {
    const onUpdate = vi.fn(() => Promise.resolve())
    render(<ShellAccessDialog manager={managerFixture({ bashAllow: ['gh workflow view'], bashDenials: denials })} open onOpenChange={vi.fn()} onUpdate={onUpdate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove gh workflow view' }))
    expect(onUpdate).toHaveBeenCalledWith({ bashAllow: [] })
    const clear = screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement
    await waitFor(() => expect(clear.disabled).toBe(false))
    fireEvent.click(clear)
    expect(onUpdate).toHaveBeenCalledWith({ clearBashDenials: true })
  })

  it('says so when nothing was refused', () => {
    render(<ShellAccessDialog manager={managerFixture()} open onOpenChange={vi.fn()} onUpdate={vi.fn()} />)
    expect(screen.getByText('Nothing refused lately.')).toBeTruthy()
  })
})

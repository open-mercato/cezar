import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LastRunCard } from './last-run-card'

afterEach(cleanup)

const NOW = Date.parse('2026-09-14T10:00:00.000Z')

describe('LastRunCard', () => {
  it('shows the status dot, label and age — cost hidden for now — and wires the two buttons', () => {
    const onRunNow = vi.fn()
    const onLog = vi.fn()
    const { container } = render(
      <LastRunCard lastRun={{ runId: 'r1', status: 'done', ts: '2026-09-14T04:00:00.000Z', costUsd: 0.33 }} onRunNow={onRunNow} onLog={onLog} now={NOW} />,
    )
    expect(screen.getByText('Last run')).not.toBeNull()
    expect(container.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(screen.getByText('done')).not.toBeNull()
    expect(screen.getByText('6h')).not.toBeNull()
    expect(screen.queryByText('$0.33')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    fireEvent.click(screen.getByRole('button', { name: 'View log' }))
    expect(onRunNow).toHaveBeenCalledTimes(1)
    expect(onLog).toHaveBeenCalledTimes(1)
  })

  it('hides the cost when costMetrics is off and the log button without a handler', () => {
    const { container } = render(
      <LastRunCard lastRun={{ runId: 'r1', status: 'failed', ts: '2026-09-14T04:00:00.000Z' }} onRunNow={() => undefined} now={NOW} />,
    )
    expect(container.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(screen.queryByText(/^\$/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'View log' })).toBeNull()
  })
})

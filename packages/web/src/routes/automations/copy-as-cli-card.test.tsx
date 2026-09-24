import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Toaster, resetToasts } from '@/components/ui/toaster'

import { CopyAsCliCard } from './copy-as-cli-card'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('CopyAsCliCard', () => {
  it('prints the flag form and copies it to the clipboard with a toast', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(
      <>
        <CopyAsCliCard definition={{ name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump', workflow: 'quick-task', autonomous: true } }} />
        <Toaster />
      </>,
    )
    const line = 'cez automation add --name "Nightly" --cron "0 4 * * *" --workflow "quick-task" --autonomous --prompt "Bump"'
    expect(screen.getByText(line)).not.toBeNull()
    expect(screen.getByText(/cez automation schema/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(line))
    await waitFor(() => expect(screen.getByText('Copied to the clipboard.')).not.toBeNull())
  })

  it('falls back to the JSON form for a poll with filters flags cannot express', () => {
    render(
      <CopyAsCliCard definition={{ name: 'Triage', kind: 'github', events: ['issue.opened'], intervalSeconds: 300, filters: { assignees: ['me'], lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'p' } }} />,
    )
    expect(screen.getByText(/^cez automation create --json/)).not.toBeNull()
  })
})

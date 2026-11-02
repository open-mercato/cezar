import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { managerFixture } from './manager-fixtures'
import { jobIsValid, JobsDialog } from './manager-settings'

afterEach(cleanup)

describe('jobIsValid', () => {
  const job = { name: 'n', prompt: 'p', everyMinutes: 60, enabled: true }

  it('holds the contract\'s bounds', () => {
    expect(jobIsValid(job)).toBe(true)
    expect(jobIsValid({ ...job, name: ' ' })).toBe(false)
    expect(jobIsValid({ ...job, prompt: '' })).toBe(false)
    expect(jobIsValid({ ...job, everyMinutes: 4 })).toBe(false)
    expect(jobIsValid({ ...job, everyMinutes: 10_081 })).toBe(false)
  })
})

describe('JobsDialog', () => {
  const existing = { id: 'j1', name: 'Nightly', prompt: 'Summarize', everyMinutes: 1440, enabled: true, lastRunAt: 'x' }

  it('adds a job, keeps existing ids, and drops server-owned keys', async () => {
    const onSave = vi.fn(() => Promise.resolve())
    const onOpenChange = vi.fn()
    render(<JobsDialog manager={managerFixture({ jobs: [existing] })} open onOpenChange={onOpenChange} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add job' }))
    expect((screen.getByRole('button', { name: 'Save jobs' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getAllByLabelText('Job name')[1]!, { target: { value: 'Weekly' } })
    fireEvent.change(screen.getAllByLabelText('Job prompt')[1]!, { target: { value: 'Report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save jobs' }))
    expect(onSave).toHaveBeenCalledWith([
      { id: 'j1', name: 'Nightly', prompt: 'Summarize', everyMinutes: 1440, enabled: true },
      { name: 'Weekly', prompt: 'Report', everyMinutes: 60, enabled: true },
    ])
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('removes a job', () => {
    const onSave = vi.fn(() => Promise.resolve())
    render(<JobsDialog manager={managerFixture({ jobs: [existing] })} open onOpenChange={vi.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }))
    expect(screen.getByText('No jobs yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save jobs' }))
    expect(onSave).toHaveBeenCalledWith([])
  })

  it('stays open on a refused save', async () => {
    const onOpenChange = vi.fn()
    render(<JobsDialog manager={managerFixture()} open onOpenChange={onOpenChange} onSave={() => Promise.reject(new Error('no'))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save jobs' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save jobs' }) as HTMLButtonElement).disabled).toBe(false))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

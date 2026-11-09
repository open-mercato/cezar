import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { managerFixture } from './manager-fixtures'
import { jobIsValid, JobsDialog, PersonaDialog } from './manager-settings'

afterEach(cleanup)

describe('jobIsValid', () => {
  const job = { name: 'n', prompt: 'p', everyMinutes: 60, enabled: true }

  it('holds the contract\'s bounds', () => {
    expect(jobIsValid(job)).toBe(true)
    expect(jobIsValid({ ...job, name: ' ' })).toBe(false)
    expect(jobIsValid({ ...job, prompt: '' })).toBe(false)
    expect(jobIsValid({ ...job, everyMinutes: 4 })).toBe(false)
    expect(jobIsValid({ ...job, everyMinutes: 10_081 })).toBe(false)
    expect(jobIsValid({ ...job, everyMinutes: 7.5 })).toBe(false)
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


describe('PersonaDialog', () => {
  it('saves a chosen mascot without changing its instructions or legacy avatar', async () => {
    const onSave = vi.fn(() => Promise.resolve())
    const manager = managerFixture({ avatar: 7, instructions: 'Review safely' })
    render(<PersonaDialog manager={manager} open onOpenChange={vi.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Reviewer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ name: manager.name, instructions: 'Review safely', avatar: 7, mascot: 'reviewer' })
  })

  it('keeps an existing avatar when no mascot was selected', () => {
    const onSave = vi.fn(() => Promise.resolve())
    const manager = managerFixture({ avatar: 7 })
    render(<PersonaDialog manager={manager} open onOpenChange={vi.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ name: manager.name, instructions: manager.instructions, avatar: 7 })
  })
})

describe('PersonaDialog on a phone', () => {
  it('keeps Save out of the scrolling body and the name first', () => {
    render(<PersonaDialog manager={managerFixture({ mascot: 'scout' })} open onOpenChange={() => {}} onSave={() => Promise.resolve()} />)
    const save = screen.getByRole('button', { name: 'Save' })
    const name = screen.getByRole('textbox', { name: 'Name' })
    const body = name.closest('.overflow-y-auto')
    expect(body).not.toBeNull()
    expect(body!.contains(save)).toBe(false)
    expect(body!.firstElementChild!.contains(name)).toBe(true)
  })
})

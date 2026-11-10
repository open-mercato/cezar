import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOUCH_PRIMARY_QUERY } from '@/lib/enter-key'

import { managerFixture } from './manager-fixtures'
import { jobIsValid, JobsDialog, ManagerSettings, PersonaDialog } from './manager-settings'

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

  function stubTouch(touch: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: touch && query === TOUCH_PRIMARY_QUERY, media: query, addEventListener() {}, removeEventListener() {},
    }))
  }

  it('does not focus Name on a touch-primary device, so no keyboard covers the form', async () => {
    stubTouch(true)
    try {
      render(<PersonaDialog manager={managerFixture({ mascot: 'scout' })} open onOpenChange={() => {}} onSave={() => Promise.resolve()} />)
      const dialog = await screen.findByRole('dialog')
      await waitFor(() => expect(document.activeElement).toBe(dialog))
      expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Name' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still focuses Name with a mouse', async () => {
    stubTouch(false)
    try {
      render(<PersonaDialog manager={managerFixture({ mascot: 'scout' })} open onOpenChange={() => {}} onSave={() => Promise.resolve()} />)
      const name = screen.getByRole('textbox', { name: 'Name' })
      await waitFor(() => expect(document.activeElement).toBe(name))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ManagerSettings', () => {
  it.each([
    ['Persona…', 'Cancel'],
    ['Jobs…', 'Cancel'],
    ['Delete…', 'Cancel'],
    ['Persona…', 'Escape'],
    ['Jobs…', 'Escape'],
    ['Delete…', 'Escape'],
  ])('returns focus to the settings button when %s closes on %s', async (item, how) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><ManagerSettings manager={managerFixture()} onPatch={vi.fn()} /></QueryClientProvider>)
    const trigger = screen.getByRole('button', { name: 'Manager settings' })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: item }))
    const dialog = await screen.findByRole(item === 'Delete…' ? 'alertdialog' : 'dialog')
    if (how === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole(item === 'Delete…' ? 'alertdialog' : 'dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})

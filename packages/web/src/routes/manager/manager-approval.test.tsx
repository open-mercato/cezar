import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerActionRequest, ManagerConfirm } from '@open-mercato/cezar-api-client'

import { ActionCard, type DecideAction } from './manager-approval'
import { actionMessage } from './manager-fixtures'

const merge: ManagerActionRequest = { type: 'merge-pr', projectId: 'alpha', number: 12, title: 'Fix the thing', method: 'squash', headSha: '3fa9c1d2e4b5a69788' }
const job: ManagerActionRequest = { type: 'add-job', name: 'Nightly', prompt: 'Summarise every open pull request.', everyMinutes: 60 }
const automation: ManagerActionRequest = { type: 'enable-automation', projectId: 'alpha', automationId: 'auto-1', name: 'Triage', revision: 4, summary: '{"prompt":"triage"}' }

function renderCard(
  message: ReturnType<typeof actionMessage>,
  onDecide: DecideAction = vi.fn(async () => ({ ok: true })),
  managerConfirm?: ManagerConfirm,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'alpha', name: 'Meblohand', repoUrl: 'https://github.com/o/alpha' }],
    bootProject: 'alpha',
    projectsDir: '',
  })
  if (managerConfirm) client.setQueryData(workspaceQueryKeys.uiState, { managerConfirm })
  const ui = (next: typeof message) => (
    <QueryClientProvider client={client}><ActionCard message={next} onDecide={onDecide} /></QueryClientProvider>
  )
  const { rerender } = render(ui(message))
  return { onDecide, rerender: (next: typeof message) => rerender(ui(next)) }
}

const approve = () => fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

beforeEach(() => {
  // Pending forever: the ui-state query stays loading unless a test seeds it.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ActionCard', () => {
  it('fills the column with two equal thumb-sized buttons', () => {
    renderCard(actionMessage(1))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    expect(card.className).toContain('w-full')
    expect(card.className).not.toContain('max-w-lg')
    for (const name of ['Reject', 'Approve']) {
      expect(within(card).getByRole('button', { name }).className).toMatch(/\bh-11\b.*\bflex-1\b/)
    }
  })

  it('rejects at once, with no confirmation', () => {
    const { onDecide } = renderCard(actionMessage(1))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onDecide).toHaveBeenCalledWith('a1', 'reject')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('restates a merge: project, PR, title, method, head and link', () => {
    const { onDecide } = renderCard(actionMessage(1, { action: merge }))
    approve()
    expect(onDecide).not.toHaveBeenCalled()
    const sheet = within(screen.getByRole('dialog', { name: 'Merge this pull request?' }))
    expect(sheet.getByText('Meblohand')).toBeTruthy()
    expect(sheet.getByText('Fix the thing')).toBeTruthy()
    expect(sheet.getByText('squash')).toBeTruthy()
    expect(sheet.getByText('3fa9c1d2e4b5')).toBeTruthy()
    expect(sheet.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('https://github.com/o/alpha/pull/12')
    fireEvent.click(sheet.getByRole('button', { name: 'Merge' }))
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says what an unpinned merge does instead of leaving the row out', () => {
    renderCard(actionMessage(1, { action: { type: 'merge-pr', projectId: 'gone', number: 12 } }))
    approve()
    const sheet = within(screen.getByRole('dialog'))
    expect(sheet.getByText('gone')).toBeTruthy()
    expect(sheet.getByText('Repository default')).toBeTruthy()
    expect(sheet.getByText('Latest at merge')).toBeTruthy()
    expect(sheet.queryByRole('link')).toBeNull()
  })

  it('restates an automation: name, revision and the whole summary', () => {
    renderCard(actionMessage(1, { action: automation }))
    approve()
    const sheet = within(screen.getByRole('dialog', { name: 'Enable this automation?' }))
    expect(sheet.getByText('Triage')).toBeTruthy()
    expect(sheet.getByText('4')).toBeTruthy()
    expect(sheet.getByText('{"prompt":"triage"}')).toBeTruthy()
  })

  it('restates a job: name, interval and the whole prompt', () => {
    renderCard(actionMessage(1, { action: job }))
    approve()
    const sheet = within(screen.getByRole('dialog', { name: 'Add this job?' }))
    expect(sheet.getByText('Nightly')).toBeTruthy()
    expect(sheet.getByText('Every 60 min')).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-action-full"]')?.textContent).toBe(job.prompt)
  })

  it('closes on Cancel without deciding', () => {
    const { onDecide } = renderCard(actionMessage(1))
    approve()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('clamps the detail to three lines with no nested scroller', () => {
    renderCard(actionMessage(1, { action: job }))
    const detail = document.querySelector('[data-slot="manager-action-detail"]')!
    expect(detail.className).toContain('line-clamp-3')
    expect(detail.className).not.toMatch(/overflow-auto|max-h-/)
  })

  it('keeps a clamped prompt readable with the step switched off, and once decided', () => {
    const { onDecide } = renderCard(actionMessage(1, { action: job }), undefined, { 'add-job': false })
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(document.querySelector('[data-slot="manager-action-full"]')?.textContent).toBe(job.prompt)
    expect(onDecide).not.toHaveBeenCalled()
    cleanup()
    renderCard(actionMessage(1, { action: job, status: 'done', result: 'Added job Nightly' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(document.querySelector('[data-slot="manager-action-full"]')?.textContent).toBe(job.prompt)
    expect(screen.queryByRole('button', { name: 'Add job' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('drops the confirm button when the action is decided under an open sheet', () => {
    const { rerender } = renderCard(actionMessage(1, { action: job }))
    approve()
    expect(screen.getByRole('button', { name: 'Add job' })).toBeTruthy()
    rerender(actionMessage(1, { action: job, status: 'done' }))
    expect(screen.queryByRole('button', { name: 'Add job' })).toBeNull()
  })

  it('locks only itself while its decision is in flight, against a double tap too', async () => {
    let settle = () => {}
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { settle = resolve }))
    renderCard(actionMessage(1), onDecide)
    const reject = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement
    fireEvent.click(reject)
    fireEvent.click(reject)
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(reject.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    settle()
    await waitFor(() => expect(reject.disabled).toBe(false))
  })

  it('writes a refusal on the card, and clears it on the next try', async () => {
    const onDecide = vi.fn<DecideAction>().mockRejectedValueOnce(new Error('this action is already running')).mockReturnValue(new Promise(() => {}))
    renderCard(actionMessage(1), onDecide)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect((await screen.findByRole('alert')).textContent).toContain('this action is already running')
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replaces the buttons with the outcome once decided', () => {
    renderCard(actionMessage(1, { status: 'done', result: 'Merged #12' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('Merged #12')).toBeTruthy()
  })

  it('falls back to the status when no result was written', () => {
    renderCard(actionMessage(1, { status: 'rejected' }))
    expect(screen.getByText('Rejected')).toBeTruthy()
  })
})

describe('the confirmation setting', () => {
  it('confirms by default: the setting never loaded', () => {
    const { onDecide } = renderCard(actionMessage(1))
    approve()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('confirms on an empty setting and on another type being off', () => {
    const { onDecide } = renderCard(actionMessage(1), undefined, {})
    approve()
    expect(screen.getByRole('dialog')).toBeTruthy()
    cleanup()
    renderCard(actionMessage(1), onDecide, { 'add-job': false })
    approve()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('confirms an unknown future type, even one stored as off', () => {
    const action = { type: 'delete-branch', projectId: 'alpha' } as unknown as ManagerActionRequest
    const { onDecide } = renderCard(actionMessage(1, { action }), undefined, { 'delete-branch': false })
    approve()
    expect(screen.getByRole('dialog', { name: 'Approve this action?' })).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('sends directly once switched off, with the card and its tap still there', () => {
    const { onDecide } = renderCard(actionMessage(1), undefined, { 'merge-pr': false })
    expect(onDecide).not.toHaveBeenCalled()
    approve()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve')
  })
})

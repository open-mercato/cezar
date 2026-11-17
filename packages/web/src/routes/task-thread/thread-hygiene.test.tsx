import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { ThreadHygienePanel } from './thread-hygiene'
import { getThreadStatus, continueRun } from '@/api/client'

vi.mock('@/api/client', async () => ({ ...await vi.importActual('@/api/client'), getThreadStatus: vi.fn(), continueRun: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const RUN: ApiRun = { id: 'r', title: 'UI', workflow: 'quick-task', task: 'goal', status: 'waiting', createdAt: '2026-11-17T10:00:00Z', tokensUsed: 0, archived: false, steps: [], threadHygiene: { continuations: 3, historyKnown: true, pending: { reason: 'automatic', since: '2026-11-17T11:00:00Z' } } }
const show = (run = RUN) => render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><ThreadHygienePanel run={run} /></MemoryRouter></QueryClientProvider>)
describe('thread hygiene controls', () => {
  it('opening the view invokes neither status fetch nor agent; Status is a dated saved read', async () => {
    vi.mocked(getThreadStatus).mockResolvedValue({ status: 'waiting', handoff: 'Next: reuse the accepted mockup.', contentUpdatedAt: '2026-11-17T10:40:00Z', continuations: 3, historyKnown: true })
    show()
    expect(getThreadStatus).not.toHaveBeenCalled(); expect(continueRun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Status — no agent call' }))
    await screen.findByText('Next: reuse the accepted mockup.')
    expect(getThreadStatus).toHaveBeenCalledWith('r'); expect(continueRun).not.toHaveBeenCalled()
  })
  it('handoff is an explicit bounded choice without successor creation', async () => {
    vi.mocked(continueRun).mockResolvedValue({ continued: true })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }))
    await waitFor(() => expect(continueRun).toHaveBeenCalledWith('r', { threadDecision: { action: 'handoff', expectedCount: 3 } }))
    expect(screen.getByText(/successor creation is a separate action/)).toBeTruthy()
  })
  it('a dormant long thread without a return attempt shows no decision controls', () => {
    show({ ...RUN, status: 'done', threadHygiene: { continuations: 3, historyKnown: true } })
    expect(screen.queryByRole('button', { name: 'Continue work' })).toBeNull()
    expect(continueRun).not.toHaveBeenCalled()
  })
})

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { PlanUsageConsumerWindow } from '@open-mercato/cezar-api-client'

import { planEntry } from './__fixtures__/plan-usage'
import { PlanUsageChip } from './plan-usage-chip'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function stubConsumers(entries: PlanUsageConsumerWindow[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/v1/workspace/plan-usage/consumers')) {
      return jsonResponse({
        schema: 'cezar.usage-ledger',
        version: '1.0.0',
        generatedAt: '2026-11-19T12:00:00.000Z',
        tracking: { enabled: true, retentionDays: 90, accounts: {} },
        entries,
      })
    }
    return jsonResponse({})
  }))
}

const renderChip = (runner = 'claude', startedAt: string | null = new Date(Date.now() - 3_600_000).toISOString()) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <PlanUsageChip runId="r1" runner={runner} startedAt={startedAt ?? undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe('PlanUsageChip', () => {
  it('reads "This task ≈ N% of 5h" and opens the breakdown', async () => {
    stubConsumers([
      planEntry('r1', '2026-11-19T15:00:00.000Z', { estimatePp: 25, aloneInferredPp: 4, sharedEstimatePp: 21, retryWasteEstimatePp: 11 }),
      planEntry('r1', '2026-11-24T15:00:00.000Z', { estimatePp: 1 }, { kind: 'weekly', windowId: 'week-1' }),
      planEntry('other', '2026-11-19T15:00:00.000Z', { estimatePp: 50 }),
    ])
    renderChip()
    const chip = await screen.findByRole('button', { name: /This task/ })
    expect(chip.textContent).toBe('This task ≈ 25% of 5h')
    fireEvent.click(chip)
    const details = within(await screen.findByRole('dialog'))
    expect(details.getByText('Plan limit used by this task')).toBeTruthy()
    expect(document.querySelector('[data-slot="plan-usage-window"]')?.textContent).toMatch(/^Claude · default · 5-hour limit .+–.+$/)
    expect(document.querySelector('[data-slot="plan-usage-total"]')?.textContent).toBe('≈ 25% of the 5-hour limit · ≈ 1% of the week')
    expect(details.getByText('While it was the only cezar task').nextElementSibling?.textContent).toBe('≈ 4%')
    expect(details.getByText('Its share while 2 other tasks ran').nextElementSibling?.textContent).toBe('≈ 21%')
    expect(details.getByText('of which: failed attempts').nextElementSibling?.textContent).toBe('≈ 11%')
    expect(details.getByText(/^Approximate: Claude reports usage per account/)).toBeTruthy()
    const link = details.getByRole('link', { name: 'See all tasks on this account' })
    expect(link.getAttribute('href')).toBe(
      `/dashboard?view=costs&planAccount=claude%3Adefault&planWindow=${encodeURIComponent('claude:default:five-hour:2026-11-19T15:00:00.000Z')}`,
    )
  })

  it('hides the failed-attempts line when nothing was wasted', async () => {
    stubConsumers([planEntry('r1', '2026-11-19T15:00:00.000Z', { retryWasteEstimatePp: 0, ranTogetherWith: { tasks: 1, managers: 1, internal: 0 } })])
    renderChip()
    fireEvent.click(await screen.findByRole('button', { name: /This task/ }))
    const details = within(await screen.findByRole('dialog'))
    expect(details.queryByText('of which: failed attempts')).toBeNull()
    expect(details.getByText('Its share while 1 other task and 1 manager ran')).toBeTruthy()
    expect(document.querySelector('[data-slot="plan-usage-total"]')?.textContent).toBe('≈ 25% of the 5-hour limit')
  })

  it('says "not measured yet" for a Claude/Codex run with no entry — never 0%', async () => {
    stubConsumers([])
    renderChip('codex')
    const chip = await screen.findByText(/not measured yet/)
    expect(chip.closest('[data-slot="plan-usage-chip"]')?.getAttribute('data-measured')).toBe('false')
    expect(document.body.textContent).not.toContain('0%')
  })

  it('stays out of the line for a run older than the two weeks the ledger query loads', async () => {
    stubConsumers([])
    renderChip('claude', new Date(Date.now() - 20 * 86_400_000).toISOString())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('[data-slot="plan-usage-chip"]')).toBeNull()
  })

  it('stays out of the line for tools without plan limits and for runs that never started', async () => {
    stubConsumers([])
    const { unmount } = renderChip('opencode')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('[data-slot="plan-usage-chip"]')).toBeNull()
    unmount()
    renderChip('claude', null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('[data-slot="plan-usage-chip"]')).toBeNull()
  })
})

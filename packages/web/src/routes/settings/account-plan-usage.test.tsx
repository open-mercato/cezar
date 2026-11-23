import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanUsageTracking, PlanUsageWindow } from '@open-mercato/cezar-api-client'

const mutate = vi.fn()
let tracking: PlanUsageTracking = { enabled: true, retentionDays: 90, accounts: {} }
let windows: Record<string, PlanUsageWindow[]> = {}

vi.mock('@/api/plan-usage', () => ({
  usePlanUsage: (q: { kind: string }) => ({ isPending: false, isError: false, data: { windows: windows[q.kind] ?? [] } }),
  usePlanUsageTracking: () => ({ isPending: false, data: tracking }),
  useSetPlanUsageTracking: () => ({ isPending: false, mutate }),
}))

const { AccountPlanUsage, fiveHourLine, weeklyLine } = await import('./account-plan-usage')

const account = { key: 'claude:default', provider: 'claude' as const, accountId: 'default', label: 'Claude · default' }
const consumer = (id: string, estimatePp: number) => ({
  id, kind: 'task' as const, title: id, estimatePp, aloneInferredPp: 0, sharedEstimatePp: estimatePp, retryWasteEstimatePp: 0,
  ranTogetherWith: { tasks: 0, managers: 0, internal: 0 }, evidence: 'account-level' as const,
})
const win = (over: Partial<PlanUsageWindow>): PlanUsageWindow => ({
  id: 'w', account, kind: 'five-hour', startsAt: '2026-11-19T10:00:00Z', resetsAt: '2026-11-19T15:00:00Z', current: true,
  usedPercent: { first: 10, last: 100 }, readings: [], consumers: [consumer('run:p/a', 50), consumer('mgr:m', 33)],
  beforeTrackingPp: 10, outsideCezarPp: 7, unsplitPp: 0, correctionPp: 0, untrackedPp: 0, trackingGaps: [], leftPp: 0, ...over,
})

beforeEach(() => {
  mutate.mockReset()
  tracking = { enabled: true, retentionDays: 90, accounts: {} }
  windows = {}
})
afterEach(cleanup)

describe('limit lines', () => {
  it('names a provider correction so the parts add up to the amount used (QA F3)', () => {
    expect(fiveHourLine(win({ correctionPp: 3 }))).toMatch(/provider correction −3%$/)
  })

  it('marks cezar\'s share ≈ and keeps provider readings and remainders plain', () => {
    expect(fiveHourLine(win({}))).toMatch(/^100% used · resets .+ · cezar tasks and managers ≈ 83% of it, outside cezar 7%, before tracking 10%$/)
    expect(weeklyLine(win({ kind: 'weekly', usedPercent: { first: 0, last: 29 }, consumers: [consumer('run:p/a', 22)] })))
      .toMatch(/^29% used · resets .+ · this week: cezar ≈ 22%, outside cezar 7%, before tracking 10%$/)
  })

  it('says no reading yet instead of 0%', () => {
    expect(fiveHourLine(undefined)).toBe('no reading yet')
    expect(weeklyLine(win({ usedPercent: null }))).toBe('no reading yet')
  })
})

describe('AccountPlanUsage', () => {
  it('shows both limits for this account and toggles tracking for its key', () => {
    windows = {
      'five-hour': [win({ account: { ...account, key: 'claude:work' }, consumers: [] }), win({})],
      weekly: [win({ kind: 'weekly', usedPercent: { first: 0, last: 29 } })],
    }
    render(<AccountPlanUsage provider="claude" accountId="default" />)
    expect(document.querySelector('[data-slot="account-plan-five-hour"]')!.textContent).toMatch(/≈ 83% of it/)
    expect(document.querySelector('[data-slot="account-plan-weekly"]')!.textContent).toMatch(/^29% used/)
    expect(screen.getByText(/Saves the limit readings on this computer \(no prompts or code\).*Kept 90 days\./)).toBeTruthy()
    expect(screen.queryByText(/used only by cezar/)).toBeNull()
    const toggle = screen.getByRole('switch', { name: 'Track plan limit usage' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(mutate.mock.calls[0]![0]).toEqual({ account: 'claude:default', enabled: false })
  })

  it('reflects a per-account opt-out', () => {
    tracking = { enabled: true, retentionDays: 90, accounts: { 'codex:work': false } }
    render(<AccountPlanUsage provider="codex" accountId="work" />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })

  it('is disabled with the reason when CEZ_USAGE_LOG=0 turned tracking off', () => {
    tracking = { enabled: false, reason: 'CEZ_USAGE_LOG=0 turns plan usage tracking off.', retentionDays: 90, accounts: {} }
    render(<AccountPlanUsage provider="claude" accountId="default" />)
    const toggle = screen.getByRole('switch')
    expect(toggle.hasAttribute('disabled')).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('[data-slot="account-plan-tracking-off"]')!.textContent).toBe('CEZ_USAGE_LOG=0 turns plan usage tracking off.')
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { LIVE_USAGE_STORAGE_KEY } from '@/lib/live-usage-pref'

import { AccountUsageWidget } from './account-usage-widget'

const NOW = Date.now()
const FUTURE_5H = new Date(NOW + 2 * 3600_000).toISOString()
const FUTURE_7D = new Date(NOW + 5 * 86400_000).toISOString()

function createTestClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(queryKeys.health, {
    capabilities: { localHandoff: true, managers: true },
    defaultRunner: 'claude',
  })
  client.setQueryData(workspaceQueryKeys.accountUsage, {
    accounts: [
      {
        id: 'default',
        provider: 'claude',
        label: 'Default',
        isDefault: true,
        routeId: 'claude:default',
        usage: {
          at: new Date(NOW).toISOString(),
          limits: [
            { window: 'five_hour', utilization: 0.25, resetsAt: FUTURE_5H },
            { window: 'seven_day', utilization: 0.6, resetsAt: FUTURE_7D },
          ],
        },
      },
      {
        id: 'work',
        provider: 'claude',
        label: 'Work Team',
        isDefault: false,
        routeId: 'claude:work',
        usage: {
          at: new Date(NOW).toISOString(),
          limits: [
            { window: 'five_hour', utilization: 0.85, resetsAt: FUTURE_5H },
            { window: 'seven_day', utilization: 0.9, resetsAt: FUTURE_7D },
          ],
        },
      },
      {
        id: 'default',
        provider: 'codex',
        label: 'Default Codex',
        isDefault: true,
        routeId: 'codex:default',
        usage: {
          at: new Date(NOW).toISOString(),
          limits: [
            { window: 'five_hour', utilization: 0.1, resetsAt: FUTURE_5H },
          ],
        },
      },
    ],
  })
  client.setQueryData(workspaceQueryKeys.agentProfiles, {
    editable: true,
    profiles: [
      { id: 'default', provider: 'claude', label: 'Default', isDefault: true, configDir: '' },
      { id: 'work', provider: 'claude', label: 'Work Team', isDefault: false, configDir: '' },
      { id: 'default', provider: 'gemini', label: 'Personal Gemini', isDefault: true, configDir: '' },
    ],
    profileCapableProviders: ['claude', 'codex', 'gemini'],
    selections: {},
    defaults: {},
  })
  return client
}

describe('AccountUsageWidget', () => {
  beforeEach(() => {
    localStorage.setItem(LIVE_USAGE_STORAGE_KEY, '1')
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('renders all active accounts in default (unconstrained) mode', () => {
    const client = createTestClient()
    render(
      <QueryClientProvider client={client}>
        <AccountUsageWidget />
      </QueryClientProvider>,
    )
    const widget = document.querySelector('[data-slot="account-usage-widget"]')
    expect(widget).not.toBeNull()
    const chips = document.querySelectorAll('[data-slot="account-usage-chip"]')
    expect(chips.length).toBe(3)
  })

  it('filters to the manager account when runner and agentProfile are specified', () => {
    const client = createTestClient()
    render(
      <QueryClientProvider client={client}>
        <AccountUsageWidget runner="claude" agentProfile="work" />
      </QueryClientProvider>,
    )
    const widget = document.querySelector('[data-slot="account-usage-widget"]')
    expect(widget).not.toBeNull()
    expect(widget?.textContent).toContain('[Work Team]')
    expect(widget?.textContent).toContain('5h 85%')
    expect(widget?.textContent).toContain('7d 90%')
    expect(widget?.textContent).not.toContain('Default')
  })

  it('selects the default account when agentProfile is omitted', () => {
    const client = createTestClient()
    render(
      <QueryClientProvider client={client}>
        <AccountUsageWidget runner="claude" />
      </QueryClientProvider>,
    )
    const widget = document.querySelector('[data-slot="account-usage-widget"]')
    expect(widget).not.toBeNull()
    expect(widget?.textContent).toContain('[Default]')
    expect(widget?.textContent).toContain('5h 25%')
    expect(widget?.textContent).not.toContain('Work Team')
  })

  it('shows available account identity without limits when provider has no usage data (e.g. gemini)', () => {
    const client = createTestClient()
    render(
      <QueryClientProvider client={client}>
        <AccountUsageWidget runner="gemini" />
      </QueryClientProvider>,
    )
    const widget = document.querySelector('[data-slot="account-usage-widget"]')
    expect(widget).not.toBeNull()
    expect(widget?.textContent).toContain('[Personal Gemini]')
    expect(widget?.textContent).not.toContain('5h')
    expect(widget?.textContent).not.toContain('7d')
  })

  it('renders nothing when live usage is disabled in preferences', () => {
    localStorage.setItem(LIVE_USAGE_STORAGE_KEY, 'off')
    const client = createTestClient()
    render(
      <QueryClientProvider client={client}>
        <AccountUsageWidget runner="claude" />
      </QueryClientProvider>,
    )
    expect(document.querySelector('[data-slot="account-usage-widget"]')).toBeNull()
  })

  describe('compact (phone header)', () => {
    const renderCompact = (props: { runner?: string; agentProfile?: string }) =>
      render(
        <QueryClientProvider client={createTestClient()}>
          <AccountUsageWidget {...props} compact />
        </QueryClientProvider>,
      )

    it('shows one button with the busiest window, labelled for screen readers', () => {
      renderCompact({ runner: 'claude', agentProfile: 'work' })
      const button = screen.getByRole('button', { name: 'Plan usage: 7d at 90%. Show details' })
      expect(button.getAttribute('data-tone')).toBe('danger')
      expect(button.textContent).toBe('90%')
      expect(document.querySelector('[data-slot="account-usage-chip"]')).toBeNull()
    })

    it('opens the same chip the desktop header shows on tap', () => {
      renderCompact({ runner: 'claude' })
      const button = screen.getByRole('button', { name: 'Plan usage: 7d at 60%. Show details' })
      expect(button.getAttribute('data-tone')).toBe('warning')
      fireEvent.click(button)
      const chip = document.querySelector('[data-slot="account-usage-chip"]')
      expect(chip?.textContent).toContain('[Default]')
      expect(chip?.textContent).toContain('5h 25%')
      expect(chip?.textContent).toContain('7d 60%')
    })

    it('renders nothing for an account with no live windows', () => {
      renderCompact({ runner: 'gemini' })
      expect(document.querySelector('[data-slot="account-usage-compact"]')).toBeNull()
    })
  })
})

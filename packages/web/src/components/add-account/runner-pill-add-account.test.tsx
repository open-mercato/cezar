import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfilesResponse } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { RunnerPill } from '@/components/picker-pill'

import { AddAccountProvider } from './add-account-host'

/** "Add account…" in the runner pill (spec 2026-11-24-add-account-in-cockpit). */
describe('RunnerPill · Add account', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const mount = (profiles: AgentProfilesResponse | undefined, withProvider = true) => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    const client = createQueryClient()
    if (profiles) client.setQueryData(workspaceQueryKeys.agentProfiles, profiles)
    const pill = <RunnerPill runners={['claude', 'codex']} value="claude" onPick={() => {}} />
    render(<QueryClientProvider client={client}>{withProvider ? <AddAccountProvider>{pill}</AddAccountProvider> : pill}</QueryClientProvider>)
  }
  const openMenu = () => {
    const trigger = document.querySelector('[data-slot="runner-pill"]')!
    fireEvent.pointerDown(trigger)
  }
  const LIST: AgentProfilesResponse = { editable: true, profileCapableProviders: ['claude', 'codex'], profiles: [], selections: {}, defaults: {} }

  it('offers Add account… and opens the wizard on the current agent', async () => {
    mount(LIST)
    openMenu()
    const item = await waitFor(() => screen.getByText('Add account…'))
    fireEvent.click(item)
    await waitFor(() => expect(document.querySelector('[data-slot="add-account-wizard"]')).not.toBeNull())
    expect(document.querySelector('[data-provider="claude"][aria-checked="true"]')).not.toBeNull()
  })

  it('offers nothing where accounts cannot be added', async () => {
    mount({ ...LIST, editable: false })
    openMenu()
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /codex/ })).toBeTruthy())
    expect(screen.queryByText('Add account…')).toBeNull()
  })
})

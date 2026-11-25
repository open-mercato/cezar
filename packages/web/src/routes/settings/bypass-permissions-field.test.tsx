import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { BypassPermissionsField } from './bypass-permissions-field'

/** Settings → Agents → Permissions: the opt-in "skip all permission prompts" toggle. */
const BASE: ConfigResponse = {
  baseBranch: null, defaultRunner: 'claude', systemPrompt: null, branchNaming: null, defaultModels: {}, modelsLocked: false,
  maxParallel: 2, memoryLimitMb: null, worktreeRetention: 10, worktreeIdleDays: 7, worktreeIdleDaysOwn: false, archivedTaskDeleteDays: 90, archivedTaskDeleteDaysOwn: false, liveTitleUpdates: null, reviewGate: null,
  profile: null, taskWorkspace: null, landing: null, landingBlocked: null, requiredChecks: [], defaultSkill: null, askSkill: null,
  teamSkills: true, bypassPermissions: false, bypassPermissionsBlocked: null,
}

let puts: unknown[] = []

function renderField(config: Partial<ConfigResponse> = {}) {
  puts = []
  const state = { ...BASE, ...config }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT' && String(input).endsWith('/config')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      puts.push(body)
      return new Response(JSON.stringify({ ...state, ...body }), { headers: { 'content-type': 'application/json' } })
    }
    return new Promise<never>(() => {})
  }))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <BypassPermissionsField config={state} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BypassPermissionsField', () => {
  it('is off by default and says what turning it on does', () => {
    renderField()
    expect(slot('agents-bypass-permissions')?.getAttribute('aria-checked')).toBe('false')
    expect(slot('agents-permissions')?.textContent).toMatch(/approved without asking/)
    expect(slot('agents-bypass-permissions-blocked')).toBeNull()
  })

  it('turns it on, and off by clearing the key', async () => {
    renderField()
    fireEvent.click(slot('agents-bypass-permissions')!)
    await waitFor(() => expect(puts).toEqual([{ bypassPermissions: true }]))
    cleanup()
    renderField({ bypassPermissions: true })
    fireEvent.click(slot('agents-bypass-permissions')!)
    await waitFor(() => expect(puts).toEqual([{ bypassPermissions: null }]))
  })

  it('shows why a git-tracked config.json cannot grant it', () => {
    renderField({ bypassPermissions: true, bypassPermissionsBlocked: 'tracked by git' })
    expect(slot('agents-bypass-permissions-blocked')?.textContent).toBe('tracked by git')
  })
})

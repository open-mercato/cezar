import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { BypassPermissionsField } from './bypass-permissions-field'

/** Settings → Agents → Permissions: the opt-in "skip all permission prompts" toggle. */
const BASE: ConfigResponse = {
  baseBranch: null, defaultRunner: 'claude', systemPrompt: null, branchNaming: null, defaultModels: {}, modelsLocked: false,
  maxParallel: 2, memoryLimitMb: null, worktreeRetention: 10, worktreeIdleDays: 7, worktreeIdleDaysOwn: false, archivedTaskDeleteDays: 90, archivedTaskDeleteDaysOwn: false, liveTitleUpdates: null, reviewGate: null,
  profile: null, taskWorkspace: null, landing: null, landingBlocked: null, requiredChecks: [], defaultSkill: null, askSkill: null,
  teamSkills: true, bypassPermissions: false, bypassPermissionsBlocked: null, claudePermissionMode: null,
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

/** Radix Select in jsdom: open from the keyboard, pick with a click on the option. */
async function pick(trigger: HTMLElement, option: string | RegExp) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: option }))
}
const modeSelect = () => screen.getByLabelText<HTMLButtonElement>('Claude permission prompts')

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

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

  describe('Claude permission prompts', () => {
    it('defaults to denying anything not allowed and explains the three modes', () => {
      renderField()
      expect(modeSelect().getAttribute('data-value')).toBe('default')
      expect(modeSelect().textContent).toBe('Deny anything not allowed (default)')
      expect(modeSelect().disabled).toBe(false)
      expect(slot('agents-claude-permission-mode-note')).toBeNull()
      expect(slot('agents-permissions')?.textContent).toMatch(/Needs you/)
    })

    it('shows the saved mode', () => {
      renderField({ claudePermissionMode: 'acceptEdits' })
      expect(modeSelect().getAttribute('data-value')).toBe('acceptEdits')
      expect(modeSelect().textContent).toBe('Ask me; accept file edits automatically')
    })

    it('offers the three options', async () => {
      renderField()
      fireEvent.keyDown(modeSelect(), { key: 'ArrowDown' })
      const listbox = await screen.findByRole('listbox')
      expect([...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
        'Deny anything not allowed (default)',
        'Ask me in the cockpit',
        'Ask me; accept file edits automatically',
      ])
    })

    it('saves manual, then acceptEdits', async () => {
      renderField()
      await pick(modeSelect(), 'Ask me in the cockpit')
      await waitFor(() => expect(puts).toEqual([{ claudePermissionMode: 'manual' }]))
      cleanup()
      renderField()
      await pick(modeSelect(), 'Ask me; accept file edits automatically')
      await waitFor(() => expect(puts).toEqual([{ claudePermissionMode: 'acceptEdits' }]))
    })

    it('clears the key when the default is picked again', async () => {
      renderField({ claudePermissionMode: 'manual' })
      await pick(modeSelect(), 'Deny anything not allowed (default)')
      await waitFor(() => expect(puts).toEqual([{ claudePermissionMode: null }]))
    })

    it('is disabled while "skip all permission prompts" overrides it', () => {
      renderField({ bypassPermissions: true, claudePermissionMode: 'manual' })
      expect(modeSelect().disabled).toBe(true)
      expect(slot('agents-claude-permission-mode-note')?.textContent).toMatch(/Skip all permission prompts.*overrides/)
    })

    it('stays enabled when a git-tracked config.json makes the server ignore the bypass', () => {
      renderField({ bypassPermissions: true, bypassPermissionsBlocked: 'tracked by git', claudePermissionMode: 'manual' })
      expect(modeSelect().disabled).toBe(false)
      expect(slot('agents-claude-permission-mode-note')).toBeNull()
    })
  })
})

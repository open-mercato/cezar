import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { visibleSettingsSections } from './registry'
import { UnitsSection } from './units-section'

/**
 * Settings → Units (spec `2026-09-08-units-hierarchy` §Role prompts): the round-trip against a
 * stubbed `/api/v1/units/prompts` — three roles with their provenance badge, edits local until
 * Save, and a Restore that goes through the design-system dialog rather than a native one.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []
const fetchMock = vi.fn<typeof fetch>()

const PROMPTS = [
  { role: 'caesar', text: 'You are Caesar.', source: 'default' },
  { role: 'legate', text: 'You are a Legate.', source: 'file' },
  { role: 'centurion', text: 'You are a Centurion.', source: 'default' },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderSection(units = true) {
  requests = []
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    requests.push({ method, url, body })
    if (url === '/api/v1/health') return json({ capabilities: { units } })
    if (url === '/api/v1/units/prompts') return json({ prompts: PROMPTS })
    if (url.startsWith('/api/v1/units/prompts/')) {
      const role = url.split('/').pop()!
      // The server answers the SAVED (or restored) entry, which is what the badge follows.
      return method === 'DELETE'
        ? json({ role, text: 'You are Caesar.', source: 'default' })
        : json({ role, text: (body as { text: string }).text, source: 'file' })
    }
    return json({})
  })
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <UnitsSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

const roleRow = (role: string) =>
  document.querySelector(`[data-slot="unit-role-row"][data-role="${role}"]`) as HTMLElement
const editor = () => document.querySelector('[data-slot="unit-prompt-editor"]') as HTMLTextAreaElement
const saveButton = () => document.querySelector('[data-action="unit-prompt-save"]') as HTMLButtonElement
const restoreButton = () =>
  document.querySelector('[data-action="unit-prompt-restore"]') as HTMLButtonElement

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  resetToasts()
})
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('the Units section gate', () => {
  it('is listed in the project area only once health reports the capability', () => {
    expect(visibleSettingsSections('project').map((s) => s.id)).not.toContain('units')
    expect(visibleSettingsSections('project', { units: false }).map((s) => s.id)).not.toContain('units')
    expect(visibleSettingsSections('project', { units: true }).map((s) => s.id)).toContain('units')
    // A project-scope section: role prompts are files in THIS repo, not a machine setting.
    expect(visibleSettingsSections('global', { units: true }).map((s) => s.id)).not.toContain('units')
  })
})

describe('UnitsSection', () => {
  it('lists the three ranks with their edited/default provenance', async () => {
    renderSection()
    await waitFor(() => expect(roleRow('caesar')).not.toBeNull())
    expect(roleRow('caesar').textContent).toContain('Commander')
    expect(roleRow('caesar').querySelector('[data-slot="unit-prompt-source"]')?.textContent).toBe(
      'default',
    )
    expect(roleRow('legate').querySelector('[data-slot="unit-prompt-source"]')?.textContent).toBe(
      'edited',
    )
    expect(roleRow('centurion')).not.toBeNull()
  })

  it('opens on Caesar and follows the selected rank into the editor', async () => {
    renderSection()
    await waitFor(() => expect(editor()).not.toBeNull())
    expect(editor().value).toBe('You are Caesar.')
    fireEvent.click(roleRow('centurion'))
    expect(editor().value).toBe('You are a Centurion.')
  })

  it('keeps an unsaved draft when the rank is switched away and back', async () => {
    renderSection()
    await waitFor(() => expect(editor()).not.toBeNull())
    fireEvent.change(editor(), { target: { value: 'You are Caesar. Be brief.' } })
    fireEvent.click(roleRow('legate'))
    expect(editor().value).toBe('You are a Legate.')
    fireEvent.click(roleRow('caesar'))
    expect(editor().value).toBe('You are Caesar. Be brief.')
  })

  it('PUTs the edited prompt on Save, and only then', async () => {
    renderSection()
    await waitFor(() => expect(editor()).not.toBeNull())
    // Nothing edited yet: Save is inert, because a PUT here would rewrite a file with what it
    // already contains.
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(editor(), { target: { value: 'You are Caesar. Be brief.' } })
    expect(saveButton().disabled).toBe(false)
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0)

    fireEvent.click(saveButton())
    await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1))
    const put = requests.find((r) => r.method === 'PUT')!
    expect(put.url).toBe('/api/v1/units/prompts/caesar')
    expect(put.body).toEqual({ text: 'You are Caesar. Be brief.' })
    // The badge follows the WRITE: the answer said `file`, so the row now reads `edited`.
    await waitFor(() =>
      expect(roleRow('caesar').querySelector('[data-slot="unit-prompt-source"]')?.textContent).toBe(
        'edited',
      ),
    )
    expect(screen.getByText('Role prompt saved')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  })

  it('offers Restore only where there is an override to restore', async () => {
    renderSection()
    await waitFor(() => expect(roleRow('caesar')).not.toBeNull())
    // Caesar is on the shipped default — there is no file to delete.
    expect(restoreButton().disabled).toBe(true)
    fireEvent.click(roleRow('legate'))
    expect(restoreButton().disabled).toBe(false)
  })

  it('DELETEs through the design-system dialog, never a native one', async () => {
    renderSection()
    await waitFor(() => expect(roleRow('legate')).not.toBeNull())
    fireEvent.click(roleRow('legate'))
    fireEvent.click(restoreButton())

    // The design-system dialog stands between the click and the request.
    await waitFor(() => expect(screen.getByText('Restore the shipped legate prompt?')).toBeTruthy())
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)

    fireEvent.click(document.querySelector('[data-action="unit-prompt-restore-confirm"]')!)
    await waitFor(() => expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1))
    expect(requests.find((r) => r.method === 'DELETE')?.url).toBe('/api/v1/units/prompts/legate')
  })

  it('explains itself and asks the server for nothing when the capability is off', async () => {
    renderSection(false)
    await waitFor(() => expect(screen.getByText('Missions are off')).toBeTruthy())
    expect(requests.some((r) => r.url.startsWith('/api/v1/units'))).toBe(false)
  })
})

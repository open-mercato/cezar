import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys } from '@/api/managers'
import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerConfirm } from '@open-mercato/cezar-api-client'

import { ManagerSection } from './manager-section'

const patches: Array<{ url: string; body: unknown }> = []
const box = (name: string) => screen.getByRole('switch', { name })

type Row = { id: string; name: string; confirm?: ManagerConfirm }

function renderSection(managers: Row[] | undefined, global?: ManagerConfirm) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(workspaceQueryKeys.uiState, global ? { managerConfirm: global } : {})
  if (managers) client.setQueryData(managerKeys.list, { managers })
  render(<QueryClientProvider client={client}><ManagerSection /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  patches.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return new Promise(() => {})
    patches.push({ url: String(input), body: JSON.parse(init.body as string) })
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const all = (overrides: ManagerConfirm) => ({ 'merge-pr': true, 'enable-automation': true, 'add-job': true, 'connector-call': true, ...overrides })

describe('Settings → Manager', () => {
  it('has all four on by default for a manager that never set them', () => {
    renderSection([{ id: 'm1', name: 'Notes' }])
    for (const name of ['Merges', 'Automations', 'Jobs', 'Connector calls']) expect(box(name).getAttribute('aria-checked')).toBe('true')
  })

  it("inherits the old global answer for a type the manager never set", () => {
    renderSection([{ id: 'm1', name: 'Notes', confirm: { 'merge-pr': true } }], { 'merge-pr': false, 'add-job': false })
    expect(box('Merges').getAttribute('aria-checked')).toBe('true')
    expect(box('Jobs').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the whole map to that manager only', async () => {
    renderSection([{ id: 'm1', name: 'Notes', confirm: { 'add-job': false } }, { id: 'm2', name: 'Release' }])
    fireEvent.click(box('Merges'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]!.url).toContain('/workspace/managers/m1')
    expect(patches[0]!.body).toEqual({ confirm: all({ 'merge-pr': false, 'add-job': false }) })
    expect(box('Merges').getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the first of two switches tapped before a re-render', async () => {
    renderSection([{ id: 'm1', name: 'Notes' }])
    const merges = box('Merges')
    const jobs = box('Jobs')
    act(() => {
      merges.click()
      jobs.click()
    })
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]!.body).toEqual({ confirm: all({ 'merge-pr': false, 'add-job': false }) })
  })

  it('says so when there is no manager yet', () => {
    renderSection([])
    expect(screen.getByText(/No managers yet/)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('never offers autonomy: the copy keeps the tap', () => {
    renderSection([{ id: 'm1', name: 'Notes' }])
    expect(screen.getByText(/still needs your tap/)).toBeTruthy()
  })
})

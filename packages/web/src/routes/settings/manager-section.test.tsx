import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'

import { ManagerSection } from './manager-section'

const puts: unknown[] = []
const box = (name: string) => screen.getByRole('switch', { name })

function renderSection(state?: object) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (state) client.setQueryData(workspaceQueryKeys.uiState, state)
  render(<QueryClientProvider client={client}><ManagerSection /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  puts.length = 0
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return new Promise(() => {})
    puts.push(JSON.parse(init.body as string))
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Manager', () => {
  it('has all three on by default, on a state that never set them', () => {
    renderSection({})
    for (const name of ['Merges', 'Automations', 'Jobs']) expect(box(name).getAttribute('aria-checked')).toBe('true')
  })

  it('shows on and refuses a write while the state is loading, so nothing is clobbered', () => {
    renderSection()
    expect(box('Merges').getAttribute('aria-checked')).toBe('true')
    expect((box('Merges') as HTMLButtonElement).disabled).toBe(true)
  })

  it('writes every type, keeping the ones already off, and keeps the other keys', async () => {
    const client = renderSection({ appearance: { accent: 'blue' }, managerConfirm: { 'add-job': false } })
    fireEvent.click(box('Merges'))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ managerConfirm: { 'merge-pr': false, 'enable-automation': true, 'add-job': false } })
    expect(box('Merges').getAttribute('aria-checked')).toBe('false')
    expect(client.getQueryData(workspaceQueryKeys.uiState)).toMatchObject({ appearance: { accent: 'blue' } })
  })

  it('never offers autonomy: the copy keeps the tap', () => {
    renderSection({})
    expect(screen.getByText(/still needs your tap/)).toBeTruthy()
  })
})

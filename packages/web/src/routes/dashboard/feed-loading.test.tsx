import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { Feed } from './feed'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('keeps manual refresh available after the bounded GitHub followup is exhausted', async () => {
  vi.useFakeTimers()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    requests.push(String(url))
    return new Response(JSON.stringify({
      asOf: '2026-09-25T00:00:00Z',
      windowStart: '2026-09-18T00:00:00Z',
      filter: 'github',
      rows: [],
      truncated: false,
      coverage: { projects: [] },
      sources: [{
        key: 'github:github.com/org/repo:pr',
        state: 'unavailable',
        reason: 'Still loading GitHub',
        truncated: false,
      }],
    }))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Feed filter="github" setFilter={() => {}} count={6} more={() => {}} />
    </QueryClientProvider>,
  )
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(screen.getByText('Checking GitHub…')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
  expect(requests).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(requests).toHaveLength(2)
  fireEvent.click(screen.getByText('Checking GitHub…'))
  const refresh = screen.getByRole('button', { name: 'Refresh GitHub' })
  expect(refresh.hasAttribute('disabled')).toBe(false)
  await act(async () => { fireEvent.click(refresh) })
  expect(requests).toHaveLength(3)
  client.clear()
})

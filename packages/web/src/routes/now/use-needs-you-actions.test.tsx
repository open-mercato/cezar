import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { attentionKeys } from '@/api/attention'
import { queryKeys } from '@/api/queries'
import { DISMISS_UNDO_MS, resetDismissals } from '@/api/questions'
import type { AttentionItem, AttentionResponse } from '@open-mercato/cezar-api-client'

import { itemTarget } from './now-triage-model'
import { useNeedsYouActions } from './use-needs-you-actions'

const toasts = vi.hoisted(() => [] as string[])
vi.mock('@/components/ui/toaster', async (load) => ({
  ...(await load<typeof import('@/components/ui/toaster')>()),
  toast: (message: string) => { toasts.push(message); return 0 },
}))

/** Needs you's actions, wired as Now and Manager mode's Now use them (spec 2026-11-23-needs-you-triage). */

const question: AttentionItem = {
  key: 'question:m:shop:1', kind: 'question', title: 'Which API?', since: '2026-11-23T10:00:00.000Z', counted: true,
  managerId: 'shop', managerName: 'Shop', questionKey: 'm:shop:1',
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: false } })
  const data: AttentionResponse = {
    items: [question], counts: { total: 1, question: 1, approval: 0, task: 0, review: 0, failed: 0, message: 0 },
    revision: 'r', overrides: [], olderAfterDays: 7,
  }
  client.setQueryData(attentionKeys.all, data)
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/questions/m%3Ashop%3A1/dismiss')) return Response.json({ error: 'disk full' }, { status: 500 })
    if (url.includes('/workspace/attention/overrides')) return Response.json({ overrides: [] })
    return Response.json({})
  }))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, calls, ...renderHook(() => useNeedsYouActions(), { wrapper }) }
}

afterEach(() => {
  resetDismissals()
  toasts.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useNeedsYouActions (review of #2444, finding 1)', () => {
  it('a question whose card close fails comes back: its override is cleared and the reason is said', async () => {
    vi.useFakeTimers()
    const { result, client, calls } = setup()
    act(() => result.current.triage.dismiss(itemTarget(question)))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(calls).toContain('POST /api/v1/workspace/attention/overrides')
    expect(client.getQueryData<AttentionResponse>(attentionKeys.all)?.items).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS) })
    await act(async () => { await vi.waitFor(() => expect(toasts).toContain('Could not close “Which API?”: disk full')) })
    expect(calls).toContain('POST /api/v1/workspace/attention/overrides/clear')
    expect(client.getQueryData<AttentionResponse>(attentionKeys.all)?.overrides.some((entry) => entry.key === question.key)).toBe(false)
  })
})

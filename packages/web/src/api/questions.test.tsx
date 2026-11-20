import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { QuestionItem, QuestionsResponse } from '@open-mercato/cezar-api-client'

import { queryKeys } from './queries'
import {
  applyQuestionCounts,
  DISMISS_UNDO_MS,
  liveQuestionCount,
  markAnswering,
  noteQuestionsMaybeChanged,
  questionKeys,
  resetDismissals,
  scheduleDismiss,
  settleQuestion,
  undoDismiss,
  useLiveQuestionCount,
  usePendingDismissals,
  useQuestionsSubscription,
} from './questions'

const topics = vi.hoisted(() => ({ listeners: new Map<string, (data: unknown) => void>(), released: [] as string[] }))
vi.mock('./ws', () => ({
  subscribeTopic: (topic: string, listener: (data: unknown) => void) => {
    topics.listeners.set(topic, listener)
    return () => {
      topics.listeners.delete(topic)
      topics.released.push(topic)
    }
  },
}))

const item = (key: string, older = false): QuestionItem => ({
  key,
  source: { kind: 'manager', managerId: 'global', name: 'Global' },
  askedAt: new Date().toISOString(),
  questions: [{ header: 'Design', question: 'Which?', options: [] }],
  older,
})
const response = (open: QuestionItem[]): QuestionsResponse => ({
  open,
  closed: [],
  counts: { live: open.filter((row) => !row.older).length, older: open.filter((row) => row.older).length },
  olderAfterDays: 7,
})

const fetchMock = vi.fn<typeof fetch>()
let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  topics.listeners.clear()
  topics.released.length = 0
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  resetDismissals()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the questions topic', () => {
  it('subscribes once, in local mode only, and folds { live, older } into the cache', () => {
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } })
    renderHook(() => useQuestionsSubscription(), { wrapper })
    expect(topics.listeners.has('questions')).toBe(false)
    act(() => client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true } }))
    expect(topics.listeners.has('questions')).toBe(true)
    client.setQueryData(questionKeys.all, response([item('m:global:1')]))
    act(() => topics.listeners.get('questions')!({ live: 3, older: 1 }))
    expect(client.getQueryData<QuestionsResponse>(questionKeys.all)?.counts).toEqual({ live: 3, older: 1 })
    // A malformed frame is dropped.
    act(() => topics.listeners.get('questions')!({ live: -1 }))
    expect(client.getQueryData<QuestionsResponse>(questionKeys.all)?.counts).toEqual({ live: 3, older: 1 })
    act(() => client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } }))
    expect(topics.released).toEqual(['questions'])
  })

  // A re-ask closes one card and opens another: the counts hold, only the revision says so.
  it('re-reads the list when the revision moves at equal counts, and not when it holds', () => {
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true } })
    renderHook(() => useQuestionsSubscription(), { wrapper })
    client.setQueryData(questionKeys.all, response([item('m:global:1')]))
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    act(() => topics.listeners.get('questions')!({ live: 1, older: 0, revision: 'aaa' }))
    act(() => topics.listeners.get('questions')!({ live: 1, older: 0, revision: 'aaa' }))
    expect(invalidate).not.toHaveBeenCalled()
    act(() => topics.listeners.get('questions')!({ live: 1, older: 0, revision: 'bbb' }))
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: questionKeys.all })
    // An older server sends counts alone: equal counts stay quiet.
    act(() => topics.listeners.get('questions')!({ live: 1, older: 0 }))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('a remote cockpit re-reads the list after a run or manager frame, batched; a local one leaves it to the topic', async () => {
    vi.useFakeTimers()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    client.setQueryData(questionKeys.all, response([]))
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true } })
    noteQuestionsMaybeChanged(client)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(invalidate).not.toHaveBeenCalled()
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } })
    noteQuestionsMaybeChanged(client)
    noteQuestionsMaybeChanged(client)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: questionKeys.all })
  })
})

describe('dismiss with undo', () => {
  it('posts only after the undo window, then moves the item to Closed', async () => {
    vi.useFakeTimers()
    client.setQueryData(questionKeys.all, response([item('m:global:1'), item('m:global:2')]))
    fetchMock.mockResolvedValue(Response.json({ ok: true, item: { ...item('m:global:1'), closed: { reason: 'dismissed', at: new Date().toISOString() } } }))
    scheduleDismiss(client, 'm:global:1', 'Design')
    await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS - 1)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/workspace/questions/m%3Aglobal%3A1/dismiss')
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST')
    await vi.waitFor(() => expect(client.getQueryData<QuestionsResponse>(questionKeys.all)?.closed.map((row) => row.key)).toEqual(['m:global:1']))
    expect(client.getQueryData<QuestionsResponse>(questionKeys.all)?.counts.live).toBe(1)
  })

  it('undo cancels the POST', async () => {
    vi.useFakeTimers()
    scheduleDismiss(client, 'm:global:1', 'Design')
    undoDismiss('m:global:1')
    await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS * 2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed dismissal comes back with its error instead of looking done', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(Response.json({ error: 'disk full' }, { status: 500 }))
    const { result } = renderHook(() => usePendingDismissals(), { wrapper })
    act(() => scheduleDismiss(client, 'm:global:1', 'Design'))
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS) })
    await act(async () => { await vi.waitFor(() => expect(result.current[0]?.error).toBe('disk full')) })
    expect(result.current).toEqual([{ key: 'm:global:1', label: 'Design', paused: true, error: 'disk full' }])
    // An errored entry no longer hides its card or its count.
    expect(liveQuestionCount(response([item('m:global:1')]), result.current)).toBe(1)
  })

  it('a 409 (closed meanwhile) drops the dismissal and re-reads the list: no Retry that cannot succeed', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(Response.json({ error: 'already closed' }, { status: 409 }))
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => usePendingDismissals(), { wrapper })
    act(() => scheduleDismiss(client, 'm:global:1', 'Design'))
    expect(result.current).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(DISMISS_UNDO_MS) })
    await act(async () => { await vi.waitFor(() => expect(result.current).toEqual([])) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: questionKeys.all })
  })

  it('the badge counts live questions less those inside their undo window; Older never counts', () => {
    const data = response([item('a'), item('b'), item('c', true)])
    expect(liveQuestionCount(undefined, [])).toBeUndefined()
    expect(liveQuestionCount(data, [])).toBe(2)
    expect(liveQuestionCount(data, [{ key: 'a', label: 'A', paused: false }])).toBe(1)
    expect(liveQuestionCount(data, [{ key: 'c', label: 'C', paused: false }])).toBe(2)
  })
})

describe('the badge while an answer is on its way', () => {
  // Every render, not a poll: a one-frame dip below the true count is what this guards.
  it('never reads below the true count when the live counts drop before the list and the reply', async () => {
    const a = item('m:global:a')
    const b = item('m:global:b')
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(questionKeys.all, response([a, b]))
    fetchMock.mockImplementation(async () => Response.json(response([b])))
    const renders: Array<number | undefined> = []
    renderHook(() => { const count = useLiveQuestionCount(); renders.push(count); return count }, { wrapper })
    expect(renders.at(-1)).toBe(2)
    act(() => markAnswering(a.key, true))
    expect(renders.at(-1)).toBe(1)
    // The topic frame says the server already counts it off; the list still has it.
    act(() => applyQuestionCounts(client, { live: 1, older: 0 }))
    // The reply lands: the page settles it and clears the in-flight mark.
    act(() => {
      settleQuestion(client, { ...a, closed: { reason: 'answered', at: new Date().toISOString(), answer: 'Yes' } })
      markAnswering(a.key, false)
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(renders.at(-1)).toBe(1)
    expect(Math.min(...renders.filter((count) => count !== undefined))).toBe(1)
  })
})

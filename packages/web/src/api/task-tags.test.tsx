import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const editRunTags = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  editRunTags: (...args: unknown[]) => editRunTags(...args),
}))

import { queryKeys } from '@/api/queries'
import { useEditRunTags } from './task-tags'

/** The run-tag edit is optimistic, with rollback (spec 2026-11-23-task-tags § 7). */
describe('useEditRunTags', () => {
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    client.setQueryData(queryKeys.runs.list(), [{ id: 'r1', status: 'done', tags: [{ id: 'tt-oldtag00001', name: 'old' }] }])
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    return { client, ...renderHook(() => useEditRunTags(), { wrapper }) }
  }
  const tagsOf = (client: QueryClient) => (client.getQueryData(queryKeys.runs.list()) as Array<{ tags?: unknown }>)[0]?.tags

  it('applies the delta at once, then takes the server’s list', async () => {
    let resolve!: (v: unknown) => void
    editRunTags.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const { client, result } = setup()
    act(() => result.current.mutate({ runId: 'r1', add: [{ id: 'tt-newtag00001', name: 'new' }], remove: ['tt-oldtag00001'] }))
    await waitFor(() => expect(tagsOf(client)).toEqual([{ id: 'tt-newtag00001', name: 'new' }]))
    expect(editRunTags).toHaveBeenCalledWith('r1', { add: [{ id: 'tt-newtag00001' }], remove: ['tt-oldtag00001'] })
    await act(async () => resolve({ tags: [{ id: 'tt-newtag00001', name: 'New (server)' }] }))
    await waitFor(() => expect(tagsOf(client)).toEqual([{ id: 'tt-newtag00001', name: 'New (server)' }]))
  })

  it('rolls back on error', async () => {
    editRunTags.mockRejectedValueOnce(new Error('refused'))
    const { client, result } = setup()
    await act(async () => {
      await result.current.mutateAsync({ runId: 'r1', remove: ['tt-oldtag00001'] }).catch(() => {})
    })
    expect(tagsOf(client)).toEqual([{ id: 'tt-oldtag00001', name: 'old' }])
  })
})

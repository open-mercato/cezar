import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from './query-client'
import { githubRowsAreStale, queryKeys, useGithubOffTabInvalidation } from './queries'

afterEach(() => vi.unstubAllGlobals())

describe('GitHub list freshness (#1870)', () => {
  it('githubRowsAreStale only fires on a known, different fingerprint', () => {
    expect(githubRowsAreStale('a', { available: true, fingerprint: 'b' })).toBe(true)
    expect(githubRowsAreStale('a', { available: true, fingerprint: 'a' })).toBe(false)
    expect(githubRowsAreStale(undefined, { available: true, fingerprint: 'b' })).toBe(false)
    expect(githubRowsAreStale('a', { available: false })).toBe(false)
    expect(githubRowsAreStale('a', undefined)).toBe(false)
  })

  it('removes cached list pages when the open set changed and no GitHub tab observes them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, fingerprint: 'new' }), { headers: { 'content-type': 'application/json' } })))
    const client = createQueryClient()
    const key = queryKeys.githubPages(50)
    client.setQueryData(key, { pages: [{ available: true, issues: [], prs: [], fingerprint: 'old' }], pageParams: [] })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    renderHook(() => useGithubOffTabInvalidation(), { wrapper })
    await waitFor(() => expect(client.getQueryData(key)).toBeUndefined())
  })

  it('keeps the pages when the fingerprint is unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, fingerprint: 'same' }), { headers: { 'content-type': 'application/json' } })))
    const client = createQueryClient()
    const key = queryKeys.githubPages(50)
    client.setQueryData(key, { pages: [{ available: true, issues: [], prs: [], fingerprint: 'same' }], pageParams: [] })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    renderHook(() => useGithubOffTabInvalidation(), { wrapper })
    await waitFor(() => expect(client.getQueryState(queryKeys.githubFingerprint())?.status).toBe('success'))
    expect(client.getQueryData(key)).toBeDefined()
  })
})

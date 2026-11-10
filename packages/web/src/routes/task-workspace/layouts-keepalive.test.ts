import { afterEach, describe, expect, it, vi } from 'vitest'

import { putRunLayouts } from '@/api/client'

/**
 * The wire half of the pagehide flush: `keepalive` reaches `fetch`, and a body over the browser's
 * keepalive allowance (which it REJECTS outright) falls back to an ordinary request.
 */
function stubFetch() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ layouts: null }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('putRunLayouts', () => {
  const small = { layouts: [{ name: 'Chat', columns: [{ view: 'session' as const, width: 100 }] }], active: 'Chat' }

  it('flies keepalive when asked', async () => {
    const fetchMock = stubFetch()
    await putRunLayouts('r1', small, { keepalive: true })
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PUT', keepalive: true })
  })

  it('is an ordinary request otherwise', async () => {
    const fetchMock = stubFetch()
    await putRunLayouts('r1', small)
    expect(fetchMock.mock.calls.at(-1)?.[1]?.keepalive).toBeFalsy()
  })

  it('drops keepalive for a document past the allowance rather than have the browser refuse it', async () => {
    const fetchMock = stubFetch()
    const tabs = Array.from({ length: 12 }, (_, index) => `https://x.test/${index}?q=${'a'.repeat(2000)}`)
    const big = {
      layouts: Array.from({ length: 3 }, (_, index) => ({
        name: `L${index}`,
        columns: [{ view: 'browser' as const, width: 100, browser: { tabs, active: 0 } }],
      })),
      active: 'L0',
    }
    await putRunLayouts('r1', big, { keepalive: true })
    expect(fetchMock.mock.calls.at(-1)?.[1]?.keepalive).toBeFalsy()
  })
})

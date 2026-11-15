import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiBaseUrl } from '@open-mercato/cezar-api-client'

import { buildSkew, noteServerBuild, resetBuildIdentityForTest, subscribeBuildSkew } from '@/lib/build-identity'

const shell = (id: string | null) =>
  new Response(`<!doctype html><head>${id ? `<meta name="cezar-build" content="${id}">` : ''}</head>`, { status: 200 })

function stubDisk(id: string | null) {
  const fetchMock = vi.fn(async () => shell(id))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('build skew between the cockpit and its server', () => {
  afterEach(() => {
    setApiBaseUrl('')
    resetBuildIdentityForTest(null)
    vi.unstubAllGlobals()
  })

  it('stays silent without a page build (dev server, tests) or a server header', async () => {
    const fetchMock = stubDisk('new')
    noteServerBuild('old')
    resetBuildIdentityForTest('new')
    noteServerBuild(null)
    await settled()
    expect(buildSkew()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes no request while the builds agree', async () => {
    const fetchMock = stubDisk('b1')
    resetBuildIdentityForTest('b1')
    for (let i = 0; i < 5; i++) noteServerBuild('b1')
    await settled()
    expect(buildSkew()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for a restart when the disk holds this page but the server booted older', async () => {
    const fetchMock = stubDisk('new')
    resetBuildIdentityForTest('new')
    const seen = vi.fn()
    const unsubscribe = subscribeBuildSkew(seen)
    for (let i = 0; i < 5; i++) noteServerBuild('old')
    await settled()
    expect(buildSkew()).toBe('server')
    expect(seen).toHaveBeenCalledTimes(1)
    // One probe per server build, however many responses carry it.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/', expect.objectContaining({ cache: 'no-store' }))

    // The restart lands: the new server's header matches, and the banner goes.
    noteServerBuild('new')
    expect(buildSkew()).toBeNull()
    unsubscribe()
  })

  it('asks for a reload when the server and disk moved on past this page', async () => {
    stubDisk('new')
    resetBuildIdentityForTest('old')
    noteServerBuild('new')
    await settled()
    expect(buildSkew()).toBe('page')
  })

  it('falls back to a reload when the shell cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    resetBuildIdentityForTest('old')
    noteServerBuild('new')
    await settled()
    expect(buildSkew()).toBe('page')
  })
  it('stays silent when the bundle is served apart from its service (cez-api-base)', async () => {
    const fetchMock = stubDisk('page-build')
    setApiBaseUrl('https://cezar.example.com')
    resetBuildIdentityForTest('page-build')
    noteServerBuild('server-build')
    await settled()
    expect(buildSkew()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the shell under a same-origin path prefix', async () => {
    const fetchMock = stubDisk('new')
    setApiBaseUrl('/cezar')
    resetBuildIdentityForTest('new')
    noteServerBuild('old')
    await settled()
    expect(buildSkew()).toBe('server')
    expect(fetchMock).toHaveBeenCalledWith('/cezar/', expect.objectContaining({ cache: 'no-store' }))
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { BuildSkewBanner } from '@/components/build-skew-banner'
import { noteServerBuild, resetBuildIdentityForTest } from '@/lib/build-identity'
import * as buildIdentity from '@/lib/build-identity'

const scheduleSelfUpdate = vi.hoisted(() => vi.fn())
const getSelfUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  scheduleSelfUpdate,
  getSelfUpdate,
}))

const status: SelfUpdateStatus = {
  version: '0.21.0',
  installKind: 'managed',
  entry: '/home/u/.cezar/versions/current/node_modules/@open-mercato/cezar/dist/index.js',
  canSelfUpdate: true,
  channel: 'stable',
  restartMode: 'supervisor',
  latest: { stable: '0.21.0', nightly: null },
  updateAvailable: null,
  checkedAt: null,
  installed: [{ id: '0.21.0+local', version: '0.21.0', source: 'local', installedAt: '2026-11-15T08:00:00.000Z', active: true }],
  available: [],
  job: null,
  scheduled: null,
  activeRuns: 0,
}

async function skew(disk: string, page: string, server: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`<meta name="cezar-build" content="${disk}">`)))
  resetBuildIdentityForTest(page)
  noteServerBuild(server)
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

function renderBanner(state?: SelfUpdateStatus, { localHandoff = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (state) client.setQueryData(workspaceQueryKeys.selfUpdate, state)
  client.setQueryData(queryKeys.health, { capabilities: { localHandoff } })
  getSelfUpdate.mockResolvedValue(state ?? { ...status, canSelfUpdate: false, installed: [] })
  return render(
    <QueryClientProvider client={client}>
      <BuildSkewBanner />
    </QueryClientProvider>,
  )
}

describe('BuildSkewBanner', () => {
  afterEach(() => {
    cleanup()
    resetBuildIdentityForTest(null)
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('renders nothing while the builds agree', () => {
    renderBanner(status)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers the self-update restart, held until idle', async () => {
    scheduleSelfUpdate.mockResolvedValue({ ...status, activeRuns: 2, scheduled: { target: '0.21.0+local', requestedAt: 'now' } })
    renderBanner({ ...status, activeRuns: 2 })
    await skew('new', 'new', 'old')
    expect(screen.getByRole('status').textContent).toContain('cezar was updated, restart to finish')
    fireEvent.click(screen.getByRole('button', { name: 'Restart when idle' }))
    await waitFor(() => expect(scheduleSelfUpdate).toHaveBeenCalledWith('0.21.0+local'))
    expect(await screen.findByText(/Restarts when running tasks finish/)).toBeTruthy()
  })

  it('names the command when this install cannot restart itself', async () => {
    renderBanner({ ...status, canSelfUpdate: false, installKind: 'global-npm' })
    await skew('new', 'new', 'old')
    expect(screen.getByRole('status').textContent).toContain('Stop cezar and start it again')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers no restart a hosted cockpit would refuse, and names the host command', async () => {
    renderBanner(status, { localHandoff: false })
    await skew('new', 'new', 'old')
    expect(screen.getByRole('status').textContent).toContain('Run cezar server-deploy on the host')
    expect(screen.queryByRole('button')).toBeNull()
    expect(scheduleSelfUpdate).not.toHaveBeenCalled()
  })

  it('suggests a reload when this page is the old one', async () => {
    renderBanner(status)
    await skew('new', 'old', 'new')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('ignores repeated taps and offers retry after an offline error', async () => {
    renderBanner(status)
    await skew('new', 'old', 'new')
    let rejectAttempt: ((reason: Error) => void) | undefined
    const reload = vi.spyOn(buildIdentity, 'reloadUpdatedPage').mockImplementation(() => new Promise((_resolve, reject) => { rejectAttempt = reject }))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reloading…' }))
    expect(reload).toHaveBeenCalledOnce()
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    await act(async () => rejectAttempt?.(new TypeError('offline')))
    expect(screen.getByRole('alert').textContent).toContain('Cannot reach cezar')
    reload.mockResolvedValueOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('recovers the button if navigation never finishes, without automatically reloading', async () => {
    renderBanner(status)
    await skew('new', 'old', 'new')
    vi.useFakeTimers()
    const reload = vi.spyOn(buildIdentity, 'reloadUpdatedPage').mockResolvedValue()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByRole('alert').textContent).toContain('Reload did not finish')
    expect(screen.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })
})

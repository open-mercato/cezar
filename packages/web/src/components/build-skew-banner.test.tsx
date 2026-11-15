import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { workspaceQueryKeys } from '@/api/queries'
import { BuildSkewBanner } from '@/components/build-skew-banner'
import { noteServerBuild, resetBuildIdentityForTest } from '@/lib/build-identity'

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

function renderBanner(state?: SelfUpdateStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (state) client.setQueryData(workspaceQueryKeys.selfUpdate, state)
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

  it('suggests a reload when this page is the old one', async () => {
    renderBanner(status)
    await skew('new', 'old', 'new')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})

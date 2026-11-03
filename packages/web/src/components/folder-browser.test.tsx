import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FsBrowseResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { FolderBrowser } from '@/components/folder-browser'

const fetchMock = vi.fn<typeof fetch>()
const ROOT = 'C:\\Users\\demo'
const CHILD = `${ROOT}\\Projects`
const rootListing: FsBrowseResponse = {
  path: ROOT,
  parent: null,
  dirs: [{ name: 'Projects', path: CHILD, isRepo: false }],
  truncated: false,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function renderBrowser(initialPath: string | null = null) {
  const onSelect = vi.fn()
  const onEnter = vi.fn()
  const client = createQueryClient()
  function Browser() {
    const [path, setPath] = useState(initialPath)
    return (
      <FolderBrowser
        path={path}
        selected={null}
        onSelect={onSelect}
        onEnter={(next) => { onEnter(next); setPath(next) }}
        emptyHint="No subfolders here."
      />
    )
  }
  render(<QueryClientProvider client={client}><Browser /></QueryClientProvider>)
  return { client, onSelect, onEnter }
}

const hint = () => document.querySelector('[data-slot="fs-root-hint"]')

describe('FolderBrowser root boundary guidance (#1688)', () => {
  it.each([null, ROOT])('explains the resolved root and links to its setting from request path %s', async (path) => {
    fetchMock.mockResolvedValue(json(rootListing))
    renderBrowser(path)
    await screen.findByText('Projects')

    expect(hint()?.textContent).toContain('This is the browse root.')
    const link = screen.getByRole('link', { name: /Default browse folder.*Settings.*Projects/ })
    expect(link.getAttribute('href')).toBe('/settings/global/projects')
    // A normal document navigation also dismisses picker dialogs owned above the route.
    expect(link.getAttribute('target')).toBeNull()
    expect(document.querySelector('[data-slot="fs-breadcrumb"]')?.textContent).toBe(ROOT)
    expect(screen.queryByRole('button', { name: 'Up one level' })).toBeNull()
  })

  it('preserves selecting, entering and Up navigation; the hint returns at the absolute root', async () => {
    const requests: (string | null)[] = []
    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input), 'http://localhost').searchParams.get('path')
      requests.push(path)
      return json(path === CHILD ? { path: CHILD, parent: ROOT, dirs: [], truncated: false } : rootListing)
    })
    const { onSelect, onEnter } = renderBrowser()
    fireEvent.click(await screen.findByRole('button', { name: 'Projects' }))
    expect(onSelect).toHaveBeenCalledWith(rootListing.dirs[0])
    expect(onEnter).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open Projects' }))
    await screen.findByRole('button', { name: 'Up one level' })
    expect(hint()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Up one level' }))
    await waitFor(() => expect(hint()).not.toBeNull())
    expect(onEnter.mock.calls).toEqual([[CHILD], [ROOT]])
    expect(requests).toEqual([null, CHILD, ROOT])
  })

  it('does not mistake an initial pending listing for the root', async () => {
    let resolveBrowse: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveBrowse = resolve }))
    renderBrowser()
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(hint()).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    await waitFor(() => expect(resolveBrowse).toBeTypeOf('function'))
    resolveBrowse?.(json(rootListing))
    await waitFor(() => expect(hint()).not.toBeNull())
  })

  it('keeps permission error guidance without claiming the unavailable listing is the root', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Permission denied' }, 403))
    renderBrowser()
    await screen.findByText('Permission denied')
    expect(hint()).toBeNull()
    expect(screen.queryByRole('link', { name: /Default browse folder/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open Privacy Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('hides the root hint when a cached root listing fails to refresh', async () => {
    fetchMock.mockResolvedValueOnce(json(rootListing))
    const { client } = renderBrowser()
    await screen.findByText('Projects')
    fetchMock.mockResolvedValue(json({ error: 'Folder no longer exists' }, 404))
    await client.refetchQueries()
    await screen.findByText('Folder no longer exists')
    expect(hint()).toBeNull()
    expect(screen.queryByRole('link', { name: /Default browse folder/ })).toBeNull()
  })

  it('shows the hint alongside empty-root and truncation guidance', async () => {
    fetchMock.mockResolvedValue(json({ ...rootListing, dirs: [], truncated: true }))
    renderBrowser()
    await screen.findByText('No subfolders here.')
    expect(hint()).not.toBeNull()
    expect(screen.getByText(/Too many folders to list/)).toBeTruthy()
  })

  it('uses the canonical server path and keeps long root paths in the breadcrumb title', async () => {
    const canonical = `/srv/${'long-root-name/'.repeat(20)}demo`
    fetchMock.mockResolvedValue(json({ ...rootListing, path: canonical }))
    renderBrowser('/srv/link')
    await screen.findByText('Projects')
    const breadcrumb = document.querySelector('[data-slot="fs-breadcrumb"]')
    expect(breadcrumb?.textContent).toBe(canonical)
    expect(breadcrumb?.getAttribute('title')).toBe(canonical)
    expect(hint()).not.toBeNull()
  })
})

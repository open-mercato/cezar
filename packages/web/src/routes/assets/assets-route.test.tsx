import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectAsset, ProjectAssetsResponse, RunRecord } from '@open-mercato/cezar-api-client'

import { AssetsRoute } from './assets-route'
import { assetState, filterAssets, subjectLink } from './assets-model'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const IMPACT_PR: ProjectAsset = {
  runId: 'run-pr', runTitle: 'Assess PR 1597', runStatus: 'done', subject: { kind: 'pr', number: 1597, headSha: 'a' },
  name: 'impact.html', kind: 'html', title: 'Trunk-based model · impact', size: 10, updatedAt: at(2), versionCount: 3, stale: false,
}
const IMPACT_SPEC: ProjectAsset = {
  runId: 'run-spec', runTitle: 'Assess the spec', runStatus: 'done',
  subject: { kind: 'spec', path: '.ai/specs/2026-10-05-repo-file-browser.md', blobSha: 'b' },
  name: 'impact.html', kind: 'html', title: 'Repository file browser · impact', size: 10, updatedAt: at(60), versionCount: 1, stale: true,
}
const NOTES: ProjectAsset = {
  runId: 'run-live', runTitle: 'Write notes', runStatus: 'done', name: 'notes.md', kind: 'markdown', title: 'Notes', size: 4, updatedAt: at(120), versionCount: 1, stale: null,
}
const SHOT: ProjectAsset = {
  runId: 'run-live', runTitle: 'Write notes', runStatus: 'done', name: 'timeline.png', kind: 'image', size: 4, updatedAt: at(600), versionCount: 1, stale: null,
}

/** The runs list is the stream-patched source of a row's live status. */
const LIVE_RUN = { id: 'run-live', title: 'Write notes', workflow: 'quick-task', task: 't', status: 'running', createdAt: at(700), tokensUsed: 0, archived: false, steps: [] } as RunRecord

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function renderAssets(listing: ProjectAssetsResponse) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/assets')) return json(listing)
    if (path.endsWith('/runs')) return json([LIVE_RUN])
    return json({})
  }))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/assets']}>
        <Routes>
          <Route path="/p/:projectId/assets" element={<AssetsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const table = async () => (await screen.findByRole('table')) as HTMLElement
const rowNames = (scope: HTMLElement) =>
  [...scope.querySelectorAll('[data-slot="asset-row"]')].map((row) => row.querySelector('[data-slot="asset-link"]')?.textContent)

describe('AssetsRoute', () => {
  it('renders the rows in server order with subject links, state chips, versions and ages', async () => {
    renderAssets({ assets: [IMPACT_PR, IMPACT_SPEC, NOTES, SHOT], truncated: false })
    const t = await table()
    expect(rowNames(t)).toEqual(['Trunk-based model · impact', 'Repository file browser · impact', 'Notes', 'timeline.png'])
    const [pr, spec, notes] = [...t.querySelectorAll<HTMLElement>('[data-slot="asset-row"]')]

    expect(within(pr!).getByRole('link', { name: 'Trunk-based model · impact' }).getAttribute('href')).toBe('/p/cezar/tasks/run-pr/assets/impact.html')
    expect(within(pr!).getByRole('link', { name: 'Assess PR 1597' }).getAttribute('href')).toBe('/p/cezar/tasks/run-pr/assets/impact.html')
    expect(within(pr!).getByRole('link', { name: 'PR #1597' }).getAttribute('href')).toBe('/p/cezar/github/prs/1597')
    expect(pr!.querySelector('[data-slot="asset-state"]')?.getAttribute('data-state')).toBe('current')
    expect(pr!.textContent).toContain('v3')
    expect(pr!.textContent).toContain('2m ago')

    const specLink = within(spec!).getByRole('link', { name: 'spec 2026-10-05-repo-file-browser.md' })
    expect(specLink.getAttribute('href')).toBe('/p/cezar/git/files/.ai/specs/2026-10-05-repo-file-browser.md')
    expect(spec!.querySelector('[data-slot="asset-state"]')?.getAttribute('data-state')).toBe('stale')

    // The runs list says run-live is still running — that wins over the listing's snapshot.
    expect(await within(notes!).findByText('running')).toBeTruthy()
    expect(notes!.textContent).toContain('—')
  })

  it('filters by Impact, HTML, Markdown and Images', async () => {
    renderAssets({ assets: [IMPACT_PR, IMPACT_SPEC, NOTES, SHOT], truncated: false })
    const t = await table()
    const chip = (name: string) => screen.getByRole('button', { name })
    expect(chip('All').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(chip('Impact'))
    expect(chip('Impact').getAttribute('aria-pressed')).toBe('true')
    expect(rowNames(t)).toEqual(['Trunk-based model · impact', 'Repository file browser · impact'])
    fireEvent.click(chip('Markdown'))
    expect(rowNames(t)).toEqual(['Notes'])
    fireEvent.click(chip('Images'))
    expect(rowNames(t)).toEqual(['timeline.png'])
    fireEvent.click(chip('HTML'))
    expect(rowNames(t)).toHaveLength(2)
  })

  it('says a filter is empty without hiding the chips', async () => {
    renderAssets({ assets: [NOTES], truncated: false })
    await table()
    fireEvent.click(screen.getByRole('button', { name: 'Images' }))
    expect(screen.getByText('No images assets.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()
  })

  it('shows the empty state before any agent wrote an artifact', async () => {
    renderAssets({ assets: [], truncated: false })
    expect(await screen.findByText('No assets yet')).toBeTruthy()
    expect(screen.getByText(/shows up here and in its task's Assets tab/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('stacks the same rows as cards for small screens, and notes a truncated listing', async () => {
    renderAssets({ assets: [IMPACT_PR, NOTES], truncated: true })
    await table()
    const cards = document.querySelector('[data-slot="assets-cards"]') as HTMLElement
    expect(cards.className).toContain('md:hidden')
    expect(cards.querySelectorAll('[data-slot="asset-card"]')).toHaveLength(2)
    expect(within(cards).getAllByRole('link', { name: 'PR #1597' })).toHaveLength(1)
    expect(document.querySelector('[data-slot="assets-truncated"]')?.textContent).toBe('Showing the newest 2 assets.')
  })
})

describe('assets-model', () => {
  it('filterAssets: Impact is "has a subject"; the rest filter by kind', () => {
    const rows = [IMPACT_PR, NOTES, SHOT]
    expect(filterAssets(rows, 'all')).toEqual(rows)
    expect(filterAssets(rows, 'impact')).toEqual([IMPACT_PR])
    expect(filterAssets(rows, 'image')).toEqual([SHOT])
  })

  it('assetState: a live run is running; otherwise stale/current/none', () => {
    expect(assetState({ stale: true }, 'queued')).toBe('running')
    expect(assetState({ stale: true }, 'done')).toBe('stale')
    expect(assetState({ stale: false }, 'review')).toBe('current')
    expect(assetState({ stale: null }, 'failed')).toBe('none')
  })

  it('subjectLink encodes each path segment, never the slashes', () => {
    expect(subjectLink({ kind: 'spec', path: 'a b/c#d.md', blobSha: 'x' }).to).toBe('/git/files/a%20b/c%23d.md')
  })
})

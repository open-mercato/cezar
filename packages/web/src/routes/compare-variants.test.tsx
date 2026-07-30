import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GroupResponse, GroupVariant, RunStatus } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { CompareVariantsRoute } from './compare-variants'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const STAT_A = ' notes.md | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)'
const STAT_B = ' notes.md | 1 +\n 1 file changed, 1 insertion(+)'

function variant(letter: string, status: RunStatus, extra: Partial<GroupVariant> = {}): GroupVariant {
  return {
    id: `v${letter.toLowerCase()}`,
    variant: letter,
    title: `Add autocomplete (${letter})`,
    status,
    archived: false,
    tokensUsed: letter === 'A' ? 96_249 : 41_800,
    inputTokens: letter === 'A' ? 92_000 : 40_000,
    outputTokens: letter === 'A' ? 4_249 : 1_800,
    costUsd: letter === 'A' ? 0.31 : 0.12,
    diffStat: letter === 'A' ? STAT_A : STAT_B,
    handoffExcerpt: `- 2026-07-14 — variant ${letter}: implemented the change`,
    ...extra,
  }
}

function group(...variants: GroupVariant[]): GroupResponse {
  return { groupId: 'g1', runs: variants }
}

const DIFF = [
  'diff --git a/notes.md b/notes.md',
  'index 1111111..2222222 100644',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -1,1 +1,2 @@',
  ' # notes',
  '+variant line',
  '',
].join('\n')

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface SentRequest {
  path: string
  method: string
  body: unknown
}

/** Stubs fetch, records every request, and lets a test override specific `METHOD path` keys.
 *  Defaults: the group answers `groupBody`, per-run diffs answer `DIFF`, the runs list is empty
 *  (the route reads it for its SSE-freshness watch), every mutation succeeds. */
function stubFetch(groupBody: GroupResponse, overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({
        path,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/groups/g1') return jsonResponse(groupBody)
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([])
      if (method === 'GET' && /^\/api\/v1\/runs\/[^/]+\/diff$/.test(path)) return new Response(DIFF, { status: 200 })
      return jsonResponse({})
    }),
  )
  return sent
}

/** The winner's thread route, as a probe: navigation on success is asserted by its appearance. */
function ThreadProbe() {
  const { id } = useParams<{ id: string }>()
  return <div data-testid="thread-probe">{id}</div>
}

function renderCompare() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/compare/g1']}>
        <Routes>
          <Route path="/compare/:groupId" element={<CompareVariantsRoute />} />
          <Route path="/tasks/:id" element={<ThreadProbe />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const columns = () => [...document.querySelectorAll('[data-slot="variant-column"]')]
const pickButtons = () =>
  [...document.querySelectorAll('[data-slot="variant-pick"]')] as HTMLButtonElement[]

async function waitForColumns(count: number) {
  await waitFor(() => expect(columns()).toHaveLength(count))
}

// ---- the columns ------------------------------------------------------------------------------

describe('the compare columns', () => {
  it('renders a column per variant: letter, status pill, spend, --stat text, Progress excerpt', async () => {
    stubFetch(group(variant('A', 'review'), variant('B', 'done')))
    renderCompare()
    await waitForColumns(2)

    const [a, b] = columns()
    expect(a?.getAttribute('data-variant')).toBe('A')
    expect(b?.getAttribute('data-variant')).toBe('B')

    // The letter badge and the canonical attention grammar: review → "needs review",
    // done → "done" (deriveAttention, not a second hand-rolled mapping).
    expect(a?.querySelector('[data-slot="variant-letter"]')?.textContent).toBe('A')
    expect(a?.querySelector('[data-slot="pill"]')?.textContent).toContain('needs review')
    expect(b?.querySelector('[data-slot="pill"]')?.textContent).toContain('done')

    // Directional tokens and cost per column.
    expect(a?.textContent).toContain('IN 92.0k · OUT 4.2k')
    expect(a?.textContent).toContain('$0.31')

    // The legacy `git diff --stat` text verbatim in the mono block, labeled as git's own words.
    expect(a?.querySelector('[data-slot="variant-diffstat"]')?.textContent).toContain('2 insertions(+)')
    expect(a?.textContent).toContain('git diff --stat')

    // The handoff Progress excerpt, rendered (markdown → no leading "- ").
    await waitFor(() =>
      expect(a?.querySelector('[data-slot="variant-progress"]')?.textContent).toContain(
        'variant A: implemented the change',
      ),
    )

    // The shared header: the group title without the variant suffix.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Add autocomplete')
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('(A)')
  })

  it('removes token and cost metadata when health disables it', async () => {
    stubFetch(group(variant('A', 'review'), variant('B', 'done')), {
      'GET /api/v1/health': () =>
        jsonResponse({
          capabilities: {
            localHandoff: true,
            followups: false,
            singleProject: false,
            tokenMetrics: false,
          },
        }),
    })
    renderCompare()
    await waitForColumns(2)
    await waitFor(() => {
      expect(document.querySelector('[data-slot="variant-token-metrics"]')).toBeNull()
    })
    expect(columns()[0]?.textContent).not.toContain('IN 92.0k')
    expect(columns()[0]?.textContent).not.toContain('$0.31')
  })

  it('says "(no changes)" and "(no progress notes)" instead of empty blocks', async () => {
    stubFetch(group(variant('A', 'done', { diffStat: '', handoffExcerpt: '' }), variant('B', 'done')))
    renderCompare()
    await waitForColumns(2)
    const [a] = columns()
    expect(a?.querySelector('[data-slot="variant-diffstat"]')?.textContent).toBe('(no changes)')
    expect(a?.querySelector('[data-slot="variant-progress"]')?.textContent).toBe('(no progress notes)')
  })

  it('stacks to one column on mobile: the grid is 1-col by default, md: opens the columns', async () => {
    stubFetch(group(variant('A', 'done'), variant('B', 'done')))
    renderCompare()
    await waitForColumns(2)
    const grid = document.querySelector('[data-slot="compare-columns"]')
    expect(grid?.className).toContain('grid-cols-1')
    expect(grid?.className).toContain('md:grid-cols-2')
  })

  it('uses a three-up grid for three variants', async () => {
    stubFetch(group(variant('A', 'done'), variant('B', 'done'), variant('C', 'failed')))
    renderCompare()
    await waitForColumns(3)
    expect(document.querySelector('[data-slot="compare-columns"]')?.className).toContain('md:grid-cols-3')
  })

  it('renders the 404 as a neutral CenteredState with a way home', async () => {
    stubFetch(group(), { 'GET /api/v1/groups/g1': () => jsonResponse({ error: 'not found' }, 404) })
    renderCompare()
    await waitFor(() => expect(screen.queryByText('No such variant group')).not.toBeNull())
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/')
  })
})

// ---- the pick flow ----------------------------------------------------------------------------

describe('✔ Pick this one', () => {
  it('is disabled while any variant is still non-terminal, with the reason in the title', async () => {
    stubFetch(group(variant('A', 'review'), variant('B', 'running')))
    renderCompare()
    await waitForColumns(2)

    for (const button of pickButtons()) {
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('Every variant must finish before you can pick')
    }
  })

  it('review counts as terminal — the agent is done, a human is not', async () => {
    stubFetch(group(variant('A', 'review'), variant('B', 'failed')))
    renderCompare()
    await waitForColumns(2)
    for (const button of pickButtons()) expect(button.disabled).toBe(false)
  })

  it('confirms, POSTs the picked runId, and navigates to the winner at review', async () => {
    const sent = stubFetch(group(variant('A', 'review'), variant('B', 'done')), {
      'POST /api/v1/groups/g1/pick': () =>
        jsonResponse({ winner: { id: 'va', status: 'review' } }),
    })
    renderCompare()
    await waitForColumns(2)

    fireEvent.click(pickButtons()[0] as HTMLButtonElement)
    // Nothing was posted yet — the confirm explains that picking archives the others.
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0)
    expect(screen.getByText('Pick variant A?')).not.toBeNull()
    expect(screen.getByText(/cancelled if still open, archived/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Pick variant A/ }))
    await waitFor(() => expect(screen.queryByTestId('thread-probe')).not.toBeNull())
    expect(screen.getByTestId('thread-probe').textContent).toBe('va')

    const post = sent.find((r) => r.method === 'POST')
    expect(post?.path).toBe('/api/v1/groups/g1/pick')
    expect(post?.body).toEqual({ runId: 'va' })
  })

  it('backing out of the confirm posts nothing', async () => {
    const sent = stubFetch(group(variant('A', 'done'), variant('B', 'done')))
    renderCompare()
    await waitForColumns(2)

    fireEvent.click(pickButtons()[0] as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: 'Keep comparing' }))
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0)
    expect(screen.queryByTestId('thread-probe')).toBeNull()
  })

  it("surfaces the server's own 409 words verbatim and stays on the compare view", async () => {
    stubFetch(group(variant('A', 'review'), variant('B', 'done')), {
      'POST /api/v1/groups/g1/pick': () =>
        jsonResponse({ error: 'this variant is still active — wait for it to finish first' }, 409),
    })
    renderCompare()
    await waitForColumns(2)

    fireEvent.click(pickButtons()[0] as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: /Pick variant A/ }))
    await waitFor(() =>
      expect(
        screen.queryByText('this variant is still active — wait for it to finish first'),
      ).not.toBeNull(),
    )
    expect(screen.queryByTestId('thread-probe')).toBeNull()
    expect(columns()).toHaveLength(2)
  })
})

// ---- the full diffs ---------------------------------------------------------------------------

describe('the full diffs', () => {
  it('renders one collapsed section per variant; expanding fetches THAT diff and shows the cards', async () => {
    const sent = stubFetch(group(variant('A', 'review'), variant('B', 'done')))
    renderCompare()
    await waitForColumns(2)

    const sections = [...document.querySelectorAll('[data-slot="variant-diff"]')]
    expect(sections).toHaveLength(2)
    // Collapsed by default: no diff has been fetched yet.
    expect(sent.filter((r) => r.path.endsWith('/diff'))).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /Variant A — full diff/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="diff-file"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="diff-file-path"]')?.textContent).toBe('notes.md')
    // Only the expanded variant's diff was fetched — the review gate's cards, per variant.
    expect(sent.filter((r) => r.path.endsWith('/diff')).map((r) => r.path)).toEqual([
      '/api/v1/runs/va/diff',
    ])
  })
})

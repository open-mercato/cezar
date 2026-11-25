import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FrameworkFile, FrameworkSummary } from '@open-mercato/cezar-api-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { buildCreateCardBody, emptyNewCardForm, NewCardDialog, previewStages, validateNewCard } from './new-card-dialog'

/** New card (spec 2026-11-15-framework-board, mockup 4). */

const SDD: FrameworkFile = {
  id: 'sdd',
  name: 'SDD',
  cardFields: [
    { name: 'slug', label: 'Change id', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', from: 'title' },
    { name: 'ui', label: 'Changes a screen', type: 'boolean', default: true },
  ],
  stages: [
    { id: 'discover', name: 'Discover', mode: 'conversation' },
    { id: 'spec', name: 'Spec', gate: { kind: 'approve' } },
    { id: 'mockup', name: 'Mockup', skipUnless: 'ui' },
    { id: 'implement', name: 'Implement' },
  ],
}

describe('new card — form rules', () => {
  it('requires a title and checks the framework’s field patterns', () => {
    const form = emptyNewCardForm('sdd')
    expect(validateNewCard(form, SDD)).toMatchObject({ title: 'A card needs a title.' })
    const titled = { ...form, title: 'Partial refunds!' }
    expect(validateNewCard(titled, SDD)).toEqual({})
    const bad = { ...titled, fields: { slug: 'Not A Slug' }, touched: new Set(['slug']) }
    expect(validateNewCard(bad, SDD)).toEqual({ 'field:slug': 'Change id must match ^[a-z0-9]+(-[a-z0-9]+)*$' })
    expect(validateNewCard({ ...titled, budget: '-3' }, SDD)).toEqual({ budget: 'Budget is a positive dollar amount.' })
  })

  it('previews the stages the card runs: start at, skip first, and skipUnless', () => {
    const form = { ...emptyNewCardForm('sdd'), title: 'x', startAt: 'spec', fields: { ui: false }, touched: new Set(['ui']) }
    expect(previewStages(form, SDD).map((s) => [s.id, s.skipped])).toEqual([
      ['discover', true],
      ['spec', false],
      ['mockup', true],
      ['implement', false],
    ])
  })

  it('builds the create body: slug from the title, skip, overrides, budget', () => {
    const form = { ...emptyNewCardForm('sdd'), title: 'Partial refunds!', skipFirst: true, models: { spec: 'opus' }, budget: '12', issue: { provider: 'github', ref: '#2291', title: 'Refunds' }, autonomous: true }
    expect(buildCreateCardBody(form, SDD, true)).toEqual({
      title: 'Partial refunds!',
      framework: 'sdd',
      fields: { slug: 'partial-refunds', ui: true },
      issue: { provider: 'github', ref: '#2291' },
      ready: true,
      autonomous: true,
      skip: ['discover'],
      overrides: { spec: { model: 'opus' } },
      budgetUsd: 12,
    })
  })
})

describe('new card — dialog', () => {
  let posts: { url: string; body: unknown }[] = []
  let refuse: string | null = null
  beforeEach(() => {
    refuse = null
    posts = []
    setApiScope(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) })
          if (refuse) return new Response(JSON.stringify({ error: refuse }), { status: 409, headers: { 'content-type': 'application/json' } })
          return new Response(JSON.stringify({ run: { id: 'new', card: { title: 'x' } } }), { status: 201, headers: { 'content-type': 'application/json' } })
        }
        if (url.endsWith('/frameworks/sdd')) {
          return new Response(JSON.stringify({ framework: SDD, yaml: '', stages: [], graph: { nodes: [], edges: [] }, source: 'builtin' }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      }),
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function dialog(onOpenChange = vi.fn(), summary: Partial<FrameworkSummary> = {}) {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <NewCardDialog
          open
          onOpenChange={onOpenChange}
          frameworks={[{ id: 'sdd', name: 'SDD', source: 'builtin', stages: [], ...summary }]}
          activeFramework="sdd"
          slots={{ busy: 3, max: 4 }}
          readyAhead={1}
        />
      </QueryClientProvider>,
    )
    return onOpenChange
  }

  it('refuses to create without a title or with a bad change id, then creates a Ready card', async () => {
    const onOpenChange = dialog()
    await screen.findByLabelText('Change id')
    expect(screen.getByText(/3\/4 busy now · 1 card ahead/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save to Backlog' }))
    expect(screen.getByText('A card needs a title.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Return labels' } })
    expect((screen.getByLabelText('Change id') as HTMLInputElement).value).toBe('return-labels')
    fireEvent.change(screen.getByLabelText('Change id'), { target: { value: 'Return Labels' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create · Ready' }))
    expect(screen.getByText('Change id must match ^[a-z0-9]+(-[a-z0-9]+)*$')).toBeTruthy()
    expect(posts).toEqual([])

    fireEvent.change(screen.getByLabelText('Change id'), { target: { value: 'return-labels-dhl' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create · Ready' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      url: '/api/v1/cards',
      body: { title: 'Return labels', framework: 'sdd', fields: { slug: 'return-labels-dhl', ui: true }, ready: true },
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('warns when the framework is not on the base ref, offers the installer, and refuses to create', async () => {
    dialog(vi.fn(), {
      installedOnBase: false,
      baseRef: 'main',
      missingOnBase: ['.ai/sdd/CONVENTIONS.md'],
      availability: { found: 0, total: 4, installable: true },
      install: { source: 'open-mercato/sdd', ref: '04ba2cc', writes: ['.ai/sdd/'], currentBranch: 'main', baseBranch: 'main' },
    })
    await screen.findByLabelText('Change id')
    const warning = screen.getByText(/SDD is not installed on main — cards fork from main/)
    expect(warning.textContent).toContain('missing: .ai/sdd/CONVENTIONS.md')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Return labels' } })
    expect((screen.getByRole('button', { name: 'Create · Ready' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Save to Backlog' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Install into this repo' }))
    expect(await screen.findByText('Install SDD into this repo?')).toBeTruthy()
    expect(posts).toEqual([])
  })

  it('no warning once it is on the base; a 409 the summary missed is shown in the form', async () => {
    refuse = 'SDD is present in the checkout but not committed on main — cards fork from main, so commit it there first (missing: .ai/sdd/sdd.mjs)'
    dialog(vi.fn(), { installedOnBase: true, baseRef: 'main', missingOnBase: [] })
    await screen.findByLabelText('Change id')
    expect(screen.queryByText(/is not installed on/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Return labels' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create · Ready' }))
    expect(await screen.findByText(/present in the checkout but not committed on main/)).toBeTruthy()
  })
})

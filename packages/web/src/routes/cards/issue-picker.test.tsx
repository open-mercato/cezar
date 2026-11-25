import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FrameworkFile, GithubItem, TrackerItem } from '@open-mercato/cezar-api-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { filterIssueOptions, issueOptions } from './issue-picker'
import { NewCardDialog } from './new-card-dialog'

/** The New card dialog's Linked issue picker (spec 2026-11-15-framework-board). */

// cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
Element.prototype.scrollIntoView = vi.fn()

const SDD: FrameworkFile = { id: 'sdd', name: 'SDD', stages: [{ id: 'spec', name: 'Spec' }] }

const ghIssue = (number: number, title: string, body?: string): GithubItem => ({
  kind: 'issue',
  number,
  title,
  author: 'octo',
  createdAt: '2026-11-01T00:00:00Z',
  labels: [],
  url: `https://github.com/acme/shop/issues/${number}`,
  comments: 0,
  ...(body ? { body } : {}),
})
const linearItem = (id: string, title: string): TrackerItem => ({
  kind: 'issue',
  id,
  title,
  author: 'Ann',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  labels: [],
  body: `Body of ${id}`,
  bodyTruncated: false,
  unsupportedContent: false,
  url: `https://linear.app/acme/issue/${id}`,
  status: 'Todo',
})
const ASSOCIATION = { kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app/acme' }, externalId: 'team', externalName: 'Shop' } as const

type Sources = { github: unknown; association: unknown; tracker: unknown }
const available: Sources = {
  github: { available: true, issues: [ghIssue(2291, 'Partial refunds', 'Refund a single line.'), ghIssue(17, 'Dark mode toggle')], prs: [] },
  association: { association: ASSOCIATION },
  tracker: { available: true, items: [linearItem('LIN-412', 'Return labels for DHL')], truncated: false },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('issue picker — options', () => {
  it('merges every available source and skips unavailable ones', () => {
    const options = issueOptions(
      [{ available: true, issues: [ghIssue(1, 'One')], prs: [] }, { available: false, reason: 'offline', issues: [], prs: [] }],
      { association: ASSOCIATION, pages: [{ available: false, code: 'unauthorized', reason: 'no' }] },
    )
    expect(options.map((o) => [o.source, o.provider, o.ref, o.url])).toEqual([['GitHub', 'github', '#1', 'https://github.com/acme/shop/issues/1']])
  })

  it('filters by ref or title tokens', () => {
    const options = issueOptions([available.github as never], { association: ASSOCIATION, pages: [available.tracker as never] })
    expect(filterIssueOptions(options, 'refund').map((o) => o.ref)).toEqual(['#2291'])
    expect(filterIssueOptions(options, '17').map((o) => o.ref)).toEqual(['#17'])
    expect(filterIssueOptions(options, 'lin-412').map((o) => o.ref)).toEqual(['LIN-412'])
  })
})

describe('issue picker — in the New card dialog', () => {
  let posts: { url: string; body: unknown }[] = []
  let requested: string[] = []

  function stub(sources: Sources) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const path = new URL(url, 'http://x').pathname
        requested.push(path)
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) })
          return json({ run: { id: 'new', card: { title: 'x' } } }, 201)
        }
        if (path.endsWith('/frameworks/sdd')) return json({ framework: SDD, yaml: '', stages: [], graph: { nodes: [], edges: [] }, source: 'builtin' })
        if (path.endsWith('/github')) return json(sources.github)
        if (path.endsWith('/tracker/association')) return json(sources.association)
        if (path.endsWith('/tracker')) return json(sources.tracker)
        return json({})
      }),
    )
  }

  beforeEach(() => {
    posts = []
    requested = []
    setApiScope(null)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function dialog() {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <NewCardDialog open onOpenChange={vi.fn()} frameworks={[{ id: 'sdd', name: 'SDD', source: 'builtin', stages: [] }]} activeFramework="sdd" />
      </QueryClientProvider>,
    )
  }
  const ready = () => waitFor(() => expect(document.querySelector('[data-stage="spec"]')).toBeTruthy())
  const openPicker = () => fireEvent.click(screen.getByLabelText('Linked issue'))
  const search = (text: string) => fireEvent.change(screen.getByPlaceholderText(/Search issues/), { target: { value: text } })
  const options = () => [...document.querySelectorAll('[data-slot="issue-picker-option"]')].map((el) => el.getAttribute('data-issue'))

  it('fetches nothing until opened, then lists GitHub and tracker issues with their source', async () => {
    stub(available)
    dialog()
    await ready()
    expect(requested.some((p) => p.endsWith('/github') || p.includes('/tracker'))).toBe(false)

    openPicker()
    await waitFor(() => expect(options()).toEqual(['#2291', '#17', 'LIN-412']))
    expect(screen.getByText('Partial refunds')).toBeTruthy()
    expect(screen.getByText('Return labels for DHL')).toBeTruthy()
    expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Linear').length).toBeGreaterThan(0)

    search('labels')
    expect(options()).toEqual(['LIN-412'])
  })

  it('picking fills the issue, an empty title and brief, and can be cleared', async () => {
    stub(available)
    dialog()
    await ready()
    openPicker()
    await waitFor(() => expect(options()).toContain('#2291'))
    search('refunds')
    fireEvent.click(screen.getByText('Partial refunds'))

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Partial refunds')
    expect((screen.getByLabelText('Brief') as HTMLTextAreaElement).value).toBe('Refund a single line.')
    expect(screen.getByLabelText('Linked issue').textContent).toContain('#2291')

    fireEvent.click(screen.getByRole('button', { name: 'Save to Backlog' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]?.body).toMatchObject({
      title: 'Partial refunds',
      brief: 'Refund a single line.',
      issue: { provider: 'github', ref: '#2291', url: 'https://github.com/acme/shop/issues/2291' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear linked issue' }))
    expect(screen.getByLabelText('Linked issue').textContent).toContain('None')
  })

  it('keeps a typed title when picking', async () => {
    stub(available)
    dialog()
    await ready()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My own title' } })
    openPicker()
    await waitFor(() => expect(options()).toContain('LIN-412'))
    fireEvent.click(screen.getByText('Return labels for DHL'))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('My own title')
    expect((screen.getByLabelText('Brief') as HTMLTextAreaElement).value).toBe('Body of LIN-412')
    expect(screen.getByLabelText('Linked issue').textContent).toContain('LIN-412')
  })

  it('degrades quietly when every source is unavailable and offers the typed ref', async () => {
    stub({
      github: { available: false, reason: 'gh is not installed', issues: [], prs: [] },
      association: { association: null },
      tracker: { available: false, code: 'not_configured', reason: 'none' },
    })
    dialog()
    await ready()
    openPicker()
    expect(await screen.findByText(/No open issues to list/)).toBeTruthy()
    expect(screen.queryByText('gh is not installed')).toBeNull()

    search('#88')
    fireEvent.click(screen.getByText('Use “#88”'))
    expect(screen.getByLabelText('Linked issue').textContent).toContain('#88')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save to Backlog' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]?.body).toMatchObject({ issue: { provider: 'github', ref: '#88' } })
  })

  it('a failing tracker still lists GitHub issues', async () => {
    stub({ ...available, tracker: { available: false, code: 'unauthorized', reason: 'token expired' } })
    dialog()
    await ready()
    openPicker()
    await waitFor(() => expect(options()).toEqual(['#2291', '#17']))
    expect(screen.queryByText(/token expired/)).toBeNull()
  })
})

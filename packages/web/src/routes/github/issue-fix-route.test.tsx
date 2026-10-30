import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiScope, type GithubItem } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { GithubRoute } from './github'
import { writeFollowupSelection } from './hand-to-agent-draft'

const item = (n: number, kind: GithubItem['kind'] = 'issue'): GithubItem => ({ kind, number: n, title: `Issue ${n}`,
  url: `https://github.com/demo/repo/${kind === 'issue' ? 'issues' : 'pull'}/${n}`, author: 'demo',
  labels: [], comments: 0, createdAt: '2026-10-30T10:00:00Z' })
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
type Posted = { url: string; body: Record<string, unknown> }
function stub({ fixInstalled = true, post }: {
  fixInstalled?: boolean; post?: (url: string, body: Record<string, unknown>) => Promise<Response>
} = {}) {
  const posts: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/\/p\/[^/]+/, '').split('?')[0]
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      return post ? post(url, body) : json({ id: `run-${posts.length}` })
    }
    if (path === '/api/v1/github') return json({ available: true, repo: 'demo/repo',
      issues: [item(1), item(2)], prs: [item(3, 'pr')] })
    if (path?.startsWith('/api/v1/github/comments/')) return json({ available: true, comments: [], events: [] })
    if (path === '/api/v1/github/checks') return json({ available: true, checks: {} })
    if (path === '/api/v1/providers/status') return json({ providers: [{ provider: 'codex', status: 'connected', enabled: true }] })
    if (path === '/api/v1/config') return json({ defaultRunner: 'codex' })
    if (path === '/api/v1/models') return json({ runner: 'codex', models: [{ id: 'gpt-test-model', label: 'Demo model', description: '' }], source: 'live', stale: false })
    if (path === '/api/v1/skills') return json((fixInstalled ? ['om-auto-fix-issue', 'other'] : ['other'])
      .map((name) => ({ name, description: name, body: '', path: `/demo/${name}.md`, source: 'ai' })))
    if (path === '/api/v1/workflows') return json({ workflows: [{ name: 'ship-it', description: '', steps: [], source: 'file' }], issues: [] })
    return json({})
  }))
  return posts
}
function Location() { return <output data-testid="location">{useLocation().pathname}</output> }
function tree(view: 'issues' | 'prs' = 'issues', client = createQueryClient()) {
  return <QueryClientProvider client={client}><MemoryRouter initialEntries={['/github']}>
    <Location /><GithubRoute view={view} />
  </MemoryRouter></QueryClientProvider>
}
beforeEach(() => {
  localStorage.clear()
  setApiScope('project-a')
  writeFollowupSelection({ runner: 'codex', model: 'gpt-test-model', workflow: 'ship-it', skills: ['other'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals(); localStorage.clear() })

describe('Issue-list fix launch integration (#1621)', () => {
  it('queues from the row without navigating, then confirms only the selected nonqueued issue', async () => {
    const posts = stub()
    render(tree())
    const quick = await screen.findByRole('button', { name: 'Queue fix for issue #1' })
    await waitFor(() => expect((quick as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(quick)
    await waitFor(() => expect(screen.getByRole('status', { name: 'Issue fix status' }).textContent).toContain('1 queued'))
    expect(screen.getByTestId('location').textContent).toBe('/github')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('/api/v1/p/project-a/runs')
    expect(posts[0]?.body).toMatchObject({ runner: 'codex', model: 'gpt-test-model',
      steps: [{ skill: 'om-auto-fix-issue' }], task: expect.stringContaining('/issues/1') })
    expect(posts[0]?.body).not.toHaveProperty('workflow')
    expect(JSON.stringify(posts[0]?.body.steps)).not.toContain('other')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed issues' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (1)' }))
    expect(posts).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(posts).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 tasks' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]?.body.task).toContain('/issues/2')
    await waitFor(() => expect(screen.getByRole('status', { name: 'Issue fix status' }).textContent).toContain('1 queued, 1 skipped, 0 failed'))
  })

  it('keeps every confirmed POST in the original project after the route changes scope', async () => {
    let release: (() => void) | undefined
    const posts = stub({ post: async () => {
      if (posts.length === 1) await new Promise<void>((resolve) => { release = resolve })
      return json({ id: `run-${posts.length}` })
    } })
    const client = createQueryClient()
    const view = render(tree('issues', client))
    await screen.findByRole('checkbox', { name: 'Select displayed issues' })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Queue fix for issue #1' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed issues' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue fixes (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue 2 tasks' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    setApiScope('project-b')
    view.rerender(tree('issues', client))
    await act(async () => release?.())
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts.map((p) => p.url)).toEqual(['/api/v1/p/project-a/runs', '/api/v1/p/project-a/runs'])
  })

  it('explains a missing fix skill and leaves PR rows without fix or selection controls', async () => {
    const posts = stub({ fixInstalled: false })
    const view = render(tree())
    await screen.findByText('Install om-auto-fix-issue to queue fixes.')
    expect((screen.getByRole('button', { name: 'Queue fix for issue #1' }) as HTMLButtonElement).disabled).toBe(true)
    expect(posts).toHaveLength(0)
    view.unmount()
    render(tree('prs'))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-row"][data-number="3"]')?.getAttribute('href')).toBe('/github/prs/3'))
    expect(screen.queryByRole('checkbox', { name: 'Select displayed issues' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Queue fix/ })).toBeNull()
  })
})

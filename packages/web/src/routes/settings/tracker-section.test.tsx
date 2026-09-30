import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { queryKeys } from '@/api/queries'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { TrackerSection } from './tracker-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

describe('Tracker settings', () => {
  it('searches and paginates candidates before connecting the selected project', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url.endsWith('/tracker/association') && (init?.method ?? 'GET') === 'GET') return json({ association: null })
      if (url.includes('/tracker/candidates')) {
        const second = url.includes('cursor=next')
        return json({
          available: true,
          source: { id: 'acme', webUrl: 'https://acme.atlassian.net' },
          candidates: [{ id: second ? '101' : '100', name: second ? 'Beyond fifty' : 'First project' }],
          truncated: !second,
          ...(second ? {} : { nextCursor: 'next' }),
        })
      }
      if (url.endsWith('/tracker/association') && init?.method === 'PUT') {
        return json({ association: { kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '101', externalName: 'Beyond fifty' } })
      }
      return new Promise<never>(() => {})
    }))
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: true })
    render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)

    await screen.findByText(/No tracker connected/i)
    fireEvent.click(screen.getByRole('button', { name: /browse Jira/i }))
    const search = await screen.findByLabelText(/search Jira projects/i)
    fireEvent.change(search, { target: { value: 'platform' } })
    await waitFor(() => expect(requests.some((request) => request.includes('q=platform'))).toBe(true))
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Beyond fifty/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }))

    await waitFor(() => expect(requests.some((request) => request.startsWith('PUT '))).toBe(true))
  })

  it('keeps offline disconnect available for a saved association', async () => {
    let disconnected = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') { disconnected = true; return new Response(JSON.stringify({ cleared: true }), { status: 200 }) }
      if (disconnected) return new Response(JSON.stringify({ association: null }), { status: 200 })
      return new Response(JSON.stringify({ association: { kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app/acme' }, externalId: 'team', externalName: 'Platform' } }), { status: 200 })
    }))
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: true })
    render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }))
    await screen.findByText(/No tracker connected/i)
  })

  it('offers recovery for candidate discovery failures and honors rate-limit cooldown', async () => {
    let candidateCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/tracker/association')) return new Response(JSON.stringify({ association: null }), { status: 200 })
      candidateCalls += 1
      return new Response(JSON.stringify({ available: false, code: 'rate_limited', reason: 'Try later', retryAfterSeconds: 1 }), { status: 200 })
    }))
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: true })
    render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /browse Jira/i }))
    const retry = await screen.findByRole('button', { name: 'Retry in 1s' }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    expect(screen.queryByText(/No projects or teams match/i)).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy(), { timeout: 1_500 })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(candidateCalls).toBe(2))
    expect((await screen.findByRole('button', { name: 'Retry in 1s' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('settles a deferred connection into the project that started it after the scope changes', async () => {
    const saved = {
      kind: 'jira' as const,
      source: { id: 'acme', webUrl: 'https://acme.atlassian.net' },
      externalId: '100', externalName: 'Operations',
    }
    const other = {
      kind: 'linear' as const,
      source: { id: 'other-org', webUrl: 'https://linear.app/other' },
      externalId: 'other-team', externalName: 'Other team',
    }
    let resolvePut!: (response: Response) => void
    const put = new Promise<Response>((resolve) => { resolvePut = resolve })
    let putStarted!: () => void
    const started = new Promise<void>((resolve) => { putStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url.includes('/tracker/candidates')) return json({
        available: true,
        source: saved.source,
        candidates: [{ id: saved.externalId, name: saved.externalName }],
        truncated: false,
      })
      if (init?.method === 'PUT') { putStarted(); return put }
      if (url.includes('/p/project-b/tracker/association')) return json({ association: other })
      if (url.includes('/p/project-a/tracker/association')) return json({ association: null })
      return new Promise<never>(() => {})
    }))
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: true })
    client.setQueryData(['tracker', 'project-a', 'connection'], { connection: null, demo: true })
    client.setQueryData(['tracker', 'project-b', 'connection'], { connection: null, demo: true })
    setApiScope('project-a')
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: true })
    const view = render(
      <MemoryRouter><QueryClientProvider client={client}>
        <ProjectScopeProvider projectId="project-a"><TrackerSection /></ProjectScopeProvider>
      </QueryClientProvider></MemoryRouter>,
    )
    await screen.findByText(/No tracker connected/i)
    fireEvent.click(screen.getByRole('button', { name: /browse Jira/i }))
    fireEvent.click(await screen.findByRole('button', { name: saved.externalName }))
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }))
    await started

    view.rerender(
      <MemoryRouter><QueryClientProvider client={client}>
        <ProjectScopeProvider projectId="project-b"><TrackerSection /></ProjectScopeProvider>
      </QueryClientProvider></MemoryRouter>,
    )
    await screen.findByText(other.externalName)
    resolvePut(new Response(JSON.stringify({ association: saved }), { status: 200 }))

    await waitFor(() => expect(client.getQueryData(queryKeys.tracker.associationFor('project-a'))).toEqual({ association: saved }))
    expect(client.getQueryData(queryKeys.tracker.associationFor('project-b'))).toEqual({ association: other })
  })

  it('settles a deferred disconnect into the project that started it after the scope changes', async () => {
    const original = {
      kind: 'jira' as const,
      source: { id: 'acme', webUrl: 'https://acme.atlassian.net' },
      externalId: '100', externalName: 'Operations',
    }
    const other = {
      kind: 'linear' as const,
      source: { id: 'other-org', webUrl: 'https://linear.app/other' },
      externalId: 'other-team', externalName: 'Other team',
    }
    let resolveDelete!: (response: Response) => void
    const deletion = new Promise<Response>((resolve) => { resolveDelete = resolve })
    let deleteStarted!: () => void
    const started = new Promise<void>((resolve) => { deleteStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (init?.method === 'DELETE') { deleteStarted(); return deletion }
      if (url.includes('/p/project-b/tracker/association')) return json({ association: other })
      if (url.includes('/p/project-a/tracker/association')) return json({ association: original })
      return new Promise<never>(() => {})
    }))
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: true })
    client.setQueryData(['tracker', 'project-a', 'connection'], { connection: null, demo: true })
    client.setQueryData(['tracker', 'project-b', 'connection'], { connection: null, demo: true })
    setApiScope('project-a')
    const view = render(
      <MemoryRouter><QueryClientProvider client={client}>
        <ProjectScopeProvider projectId="project-a"><TrackerSection /></ProjectScopeProvider>
      </QueryClientProvider></MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }))
    await started

    view.rerender(
      <MemoryRouter><QueryClientProvider client={client}>
        <ProjectScopeProvider projectId="project-b"><TrackerSection /></ProjectScopeProvider>
      </QueryClientProvider></MemoryRouter>,
    )
    await screen.findByText(other.externalName)
    resolveDelete(new Response(JSON.stringify({ cleared: true }), { status: 200 }))

    await waitFor(() => expect(client.getQueryData(queryKeys.tracker.associationFor('project-a'))).toEqual({ association: null }))
    expect(client.getQueryData(queryKeys.tracker.associationFor('project-b'))).toEqual({ association: other })
  })
})

it.each(['Jira', 'Linear'] as const)('enables only the configured %s provider and uses its scope label', async provider => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const body = String(input).includes('/tracker/candidates')
      ? { available: true, source: { id: 'test', webUrl: 'https://example.test' }, candidates: [], truncated: false }
      : { association: null }
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  const client = createQueryClient()
  client.setQueryData(queryKeys.tracker.connection(), { connection: { id: 'fixture', kind: provider.toLowerCase() }, demo: false })
  render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)
  const ready = await screen.findByRole('button', { name: `Browse ${provider}` }) as HTMLButtonElement
  const disabled = screen.getByRole('button', { name: `Browse ${provider === 'Jira' ? 'Linear' : 'Jira'}` }) as HTMLButtonElement
  expect(ready.disabled).toBe(false)
  expect(disabled.disabled).toBe(true)
  fireEvent.click(ready)
  expect(await screen.findByLabelText(`Search ${provider === 'Jira' ? 'Jira projects' : 'Linear teams'}`)).toBeTruthy()
})

it('saves write-only credentials to the selected project and clears the secret form', async () => {
  setApiScope('project-a')
  let connection: { id: string; kind: string } | null = null
  const writes: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/tracker/connection')) {
      if (init?.method === 'PUT') {
        writes.push({ url, body: JSON.parse(String(init.body)) })
        connection = { id: '11111111-1111-4111-8111-111111111111', kind: 'jira' }
      }
      return new Response(JSON.stringify({ connection, demo: false }), { status: 200 })
    }
    return new Response(JSON.stringify({ association: null }), { status: 200 })
  }))
  const client = createQueryClient()
  render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)
  const configure = await screen.findByRole('button', { name: 'Configure Jira credentials' })
  await waitFor(() => expect((configure as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(configure)
  fireEvent.change(screen.getByLabelText('Jira site URL'), { target: { value: 'https://acme.atlassian.net' } })
  fireEvent.change(screen.getByLabelText('Account email'), { target: { value: 'person@example.test' } })
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'private-test-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save project credentials' }))
  await screen.findByRole('button', { name: 'Replace Jira credentials' })
  expect(writes).toEqual([{ url: '/api/v1/p/project-a/tracker/connection', body: {
    kind: 'jira', origin: 'https://acme.atlassian.net', email: 'person@example.test', token: 'private-test-secret',
  } }])
  expect(screen.queryByLabelText('API token')).toBeNull()
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain('private-test-secret')
  expect(JSON.stringify(client.getMutationCache().getAll().map(mutation => mutation.state.variables))).not.toContain('private-test-secret')
  expect((screen.getByRole('button', { name: 'Browse Jira' }) as HTMLButtonElement).disabled).toBe(false)
})

it('discards unsaved credentials and picker state when switching project', async () => {
  setApiScope('project-a')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).endsWith('/tracker/connection') ? { connection: null, demo: false } : { association: null },
  ), { status: 200 })))
  const client = createQueryClient()
  const element = () => <MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>
  const view = render(element())
  const configure = await screen.findByRole('button', { name: 'Configure Linear credentials' })
  await waitFor(() => expect((configure as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(configure)
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'project-a-private' } })
  setApiScope('project-b'); view.rerender(element())
  await waitFor(() => expect(screen.queryByLabelText('API token')).toBeNull())
  const next = await screen.findByRole('button', { name: 'Configure Linear credentials' })
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(next)
  expect((screen.getByLabelText('API token') as HTMLInputElement).value).toBe('')
})

it('shows local storage diagnostics and credential cleanup commands', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  const client = createQueryClient()
  client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: false, error: 'Cannot read project credentials. Re-save in Settings.' })
  client.setQueryData(queryKeys.tracker.association(), { association: null })
  render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)
  expect((await screen.findByRole('alert')).textContent).toContain('Cannot read project credentials')
  expect(screen.getByText('cez tracker-connections list')).toBeTruthy()
  expect(screen.getByText('cez tracker-connections remove <id>')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Configure Linear credentials' }) as HTMLButtonElement).disabled).toBe(false)
})

it.each(['jira', 'linear'] as const)('removing %s credentials removes the connected scope card even if metadata remains', async kind => {
  const saved = { kind, connectionId: '11111111-1111-4111-8111-111111111111', source: { id: 'source', webUrl: 'https://example.com' }, externalId: '1', externalName: 'Saved scope' }
  const client = createQueryClient()
  client.setQueryData(queryKeys.tracker.association(), { association: saved })
  client.setQueryData(queryKeys.tracker.connection(), { connection: { id: saved.connectionId, kind }, demo: false })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.endsWith('/tracker/connection')) return json(init?.method === 'DELETE' ? { cleared: true } : { connection: null, demo: false })
    if (url.endsWith('/tracker/association')) return json({ association: saved })
    return new Promise<never>(() => {})
  }))
  render(<MemoryRouter><QueryClientProvider client={client}><TrackerSection /></QueryClientProvider></MemoryRouter>)
  expect(await screen.findByText('Saved scope')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove project credentials' }))
  expect(await screen.findByText('No tracker connected.')).toBeTruthy()
  expect(screen.queryByText('Saved scope')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  expect(screen.queryByText(/This scope needs reconnection/)).toBeNull()
})

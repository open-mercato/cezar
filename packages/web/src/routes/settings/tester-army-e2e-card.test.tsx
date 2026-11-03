import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type E2eStatus } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { TesterArmyE2eCard } from './tester-army-e2e-card'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const EMPTY: E2eStatus = { configFile: null, workflow: false, credentials: [], setup: null }

function setup(options: { status?: E2eStatus; runStatus?: string; postStatus?: number; prUrl?: string } = {}) {
  const { status = EMPTY, runStatus, postStatus = 201, prUrl } = options
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'POST') {
      return postStatus === 201
        ? new Response(JSON.stringify({ runId: 'run-1234abcd' }), { status: 201 })
        : new Response(JSON.stringify({ error: 'an e2e setup is already in progress' }), { status: postStatus })
    }
    if (url.includes('/runs/')) return new Response(JSON.stringify({ id: status.setup?.runId, status: runStatus ?? status.setup?.status, branch: 'cez/run-1', ...(prUrl ? { pullRequestUrl: prUrl } : {}) }), { status: 200 })
    return new Response(JSON.stringify(status), { status: 200 })
  }))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<TesterArmyE2eCard />} />
          <Route path="/p/:projectId/tasks/:id" element={<p>task page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

describe('TesterArmy e2e card', () => {
  it('shows what the project lacks and offers one button', async () => {
    setup()
    await screen.findByText('Not configured in this checkout')
    expect(screen.getByText(/smoke tests run without one/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set up e2e' })).toBeTruthy()
    expect(screen.getByLabelText('API key').getAttribute('type')).toBe('password')
  })

  it('starts the setup with the key and opens the setup task', async () => {
    const calls = setup()
    await screen.findByText('Not configured in this checkout')
    fireEvent.change(screen.getByLabelText('Model provider'), { target: { value: 'OPENAI_API_KEY' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set up e2e' }))
    await screen.findByText('task page')
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toMatch(/\/e2e\/setup$/)
    expect(JSON.parse(post.body!)).toEqual({ credential: { name: 'OPENAI_API_KEY', value: 'sk-test' } })
  })

  it('sends no credential when the key is left empty', async () => {
    const calls = setup()
    await screen.findByText('Not configured in this checkout')
    fireEvent.click(screen.getByRole('button', { name: 'Set up e2e' }))
    await screen.findByText('task page')
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toEqual({})
  })

  it('follows a setup in flight from the live run, and blocks a second one', async () => {
    setup({ status: { ...EMPTY, setup: { runId: 'run-1', status: 'queued' } }, runStatus: 'running' })
    await screen.findByText(/Setting up —/)
    await waitFor(() => expect(document.querySelector('[data-slot="e2e-setup-run"]')?.getAttribute('data-status')).toBe('running'))
    expect((screen.getByRole('button', { name: /in progress/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reads an installed project and a stored key', async () => {
    setup({ status: { configFile: 'e2e.config.ts', workflow: true, credentials: ['AI_GATEWAY_API_KEY'], setup: { runId: 'run-1', status: 'done' } } })
    await screen.findByText('e2e.config.ts')
    expect(screen.getByText('AI_GATEWAY_API_KEY')).toBeTruthy()
    expect((screen.getByLabelText('Model provider') as HTMLSelectElement).value).toBe('AI_GATEWAY_API_KEY')
    expect(screen.getByRole('button', { name: 'Set up again' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the setup task' }).getAttribute('href')).toBe('/p/default/tasks/run-1')
  })

  it('tells the user to merge a finished setup whose config has not landed (review gate off by default)', async () => {
    setup({ status: { ...EMPTY, setup: { runId: 'run-1', status: 'done' } } })
    await screen.findByText(/Setup finished — merge branch cez\/run-1 to finish/)
  })

  it('names the tool: TesterArmy logo, its repository and a status badge', async () => {
    setup()
    await screen.findByText('Not configured in this checkout')
    expect(screen.getByRole('heading', { name: 'TesterArmy e2e' })).toBeTruthy()
    expect(document.querySelector('[data-slot="e2e-settings"] img')?.getAttribute('src')).toMatch(/tester-army/)
    expect(screen.getByRole('link', { name: /tester-army\/e2e/ }).getAttribute('href')).toBe('https://github.com/tester-army/e2e')
    expect(screen.getByText('Not set up').getAttribute('data-state')).toBe('none')
  })

  it('preselects the provider whose key is already stored', async () => {
    setup({ status: { ...EMPTY, credentials: ['OPENAI_API_KEY'] } })
    await screen.findByText('OPENAI_API_KEY')
    expect((screen.getByLabelText('Model provider') as HTMLSelectElement).value).toBe('OPENAI_API_KEY')
  })

  it('links the draft PR a finished setup opened', async () => {
    setup({ status: { ...EMPTY, setup: { runId: 'run-1', status: 'done' } }, prUrl: 'https://github.com/o/r/pull/7' })
    await screen.findByText(/its draft PR is ready — merge it to finish/)
    expect(screen.getByRole('link', { name: 'Open the draft PR' }).getAttribute('href')).toBe('https://github.com/o/r/pull/7')
  })

  it('keeps the key and says why when the server refuses', async () => {
    setup({ postStatus: 409 })
    await screen.findByText('Not configured in this checkout')
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set up e2e' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already in progress'))
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('sk-test')
  })
})

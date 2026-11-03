import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorkflowDef, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { WorkflowGraphRoute } from './workflow-graph'

/**
 * The editor route around the canvas: what it opens, and what Save / Delete / Build / Export send.
 * React Flow needs a ResizeObserver to mount; jsdom never measures a node, so nothing here reads
 * the canvas itself — the graph model is covered in `lib/workflow-graph.test.ts`, the canvas in
 * the e2e suite.
 */

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const QUICK: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
}

/** A pure skill stack saved in the compact form. */
const SHIP: WorkflowDef = {
  name: 'ship-it',
  description: 'Fix then review.',
  source: 'file',
  path: '.ai/cezar/workflows/ship-it.yaml',
  steps: [
    { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
    { id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' },
  ],
}

/** A v1 chain with a check — richer than a skill stack. */
const VERIFY: WorkflowDef = {
  name: 'verify',
  source: 'file',
  path: '.ai/cezar/workflows/verify.yaml',
  steps: [
    { id: 'implement', prompt: '{{task}}' },
    { id: 'tests', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
  ],
}

const NODES = [
  { type: 'start', category: 'flow', label: 'Start', description: 'Entry point.', ports: ['next'], outputs: [] },
  { type: 'agent', category: 'agents', label: 'Agent', description: 'One agent session.', ports: ['done', 'failed'], outputs: [] },
  { type: 'end', category: 'flow', label: 'End', description: 'Finishes the run.', ports: [], outputs: [] },
]

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/workflows') {
        return jsonResponse({ workflows: [QUICK, SHIP, VERIFY], issues: [] } satisfies WorkflowsResponse)
      }
      if (method === 'GET' && path === '/api/v1/workflows/nodes') return jsonResponse({ nodes: NODES })
      if (method === 'POST' && path === '/api/v1/workflows/validate') return jsonResponse({ issues: [] })
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse([])
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/workflows" element={<WorkflowGraphRoute />} />
          <Route path="/workflows/:name" element={<WorkflowGraphRoute />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const nameField = () => screen.findByLabelText<HTMLInputElement>('Workflow name')
const sentTo = (sent: SentRequest[], method: string, path: string) => sent.filter((r) => r.method === method && r.path === path)

/** Save is disabled until the debounced validate round-trip for the current graph settles. */
async function clickSave() {
  const btn = await screen.findByRole<HTMLButtonElement>('button', { name: /Save/ })
  await waitFor(() => expect(btn.disabled).toBe(false))
  fireEvent.click(btn)
}

describe('WorkflowGraphRoute', () => {
  it('opens a saved workflow by name, and a built-in as a copy to save under a new name', async () => {
    stubFetch()
    renderAt('/workflows/ship-it')
    expect((await nameField()).value).toBe('ship-it')
    cleanup()
    renderAt('/workflows/quick-task')
    expect((await nameField()).value).toBe('quick-task-copy')
  })

  it('saves a pure skill stack in the compact skills form, overwriting its own file', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': () => jsonResponse({ path: '.ai/cezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
    })
    renderAt('/workflows/ship-it')
    await nameField()
    await clickSave()
    await waitFor(() => expect(sentTo(sent, 'POST', '/api/v1/workflows')).toHaveLength(1))
    expect(sentTo(sent, 'POST', '/api/v1/workflows')[0]?.body).toEqual({
      name: 'ship-it',
      description: 'Fix then review.',
      skills: ['om-fix', 'om-review'],
      overwrite: true,
    })
    expect(sentTo(sent, 'POST', '/api/v1/workflows/graph')).toHaveLength(0)
  })

  it('saves anything richer as a version 2 graph', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows/graph': () => jsonResponse({ path: '.ai/cezar/workflows/verify.yaml', name: 'verify' }, 201),
    })
    renderAt('/workflows/verify')
    await nameField()
    await clickSave()
    await waitFor(() => expect(sentTo(sent, 'POST', '/api/v1/workflows/graph')).toHaveLength(1))
    const body = sentTo(sent, 'POST', '/api/v1/workflows/graph')[0]?.body as { name: string; overwrite: boolean; graph: { nodes: { id: string }[] } }
    expect(body).toMatchObject({ name: 'verify', overwrite: true })
    expect(body.graph.nodes.map((n) => n.id)).toEqual(['start', 'implement', 'tests', 'tests-retry', 'end'])
    expect(sentTo(sent, 'POST', '/api/v1/workflows')).toHaveLength(0)
  })

  it('asks before replacing another file of the same name, then overwrites', async () => {
    let calls = 0
    const sent = stubFetch({
      'POST /api/v1/workflows': () =>
        calls++ === 0
          ? jsonResponse({ error: 'workflow file already exists', exists: true }, 409)
          : jsonResponse({ path: '.ai/cezar/workflows/verify.yaml', name: 'verify' }, 201),
    })
    renderAt('/workflows/ship-it')
    fireEvent.change(await nameField(), { target: { value: 'verify' } })
    await clickSave()
    fireEvent.click(await screen.findByRole('button', { name: 'Overwrite' }))
    await waitFor(() => expect(sentTo(sent, 'POST', '/api/v1/workflows')).toHaveLength(2))
    expect(sentTo(sent, 'POST', '/api/v1/workflows').map((r) => (r.body as { overwrite?: boolean }).overwrite)).toEqual([undefined, true])
  })

  it('deletes a file workflow after a confirm, and offers no delete on a built-in', async () => {
    const sent = stubFetch({ 'DELETE /api/v1/workflows/ship-it': () => jsonResponse({ ok: true }) })
    renderAt('/workflows/ship-it')
    await nameField()
    fireEvent.click(screen.getByRole('button', { name: 'Workflow settings' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete workflow/ }))
    // Nothing is sent until the confirm.
    expect(sentTo(sent, 'DELETE', '/api/v1/workflows/ship-it')).toHaveLength(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(sentTo(sent, 'DELETE', '/api/v1/workflows/ship-it')).toHaveLength(1))
    // Back on a new canvas.
    await waitFor(async () => expect((await nameField()).value).toBe(''))

    cleanup()
    renderAt('/workflows/quick-task')
    await nameField()
    fireEvent.click(screen.getByRole('button', { name: 'Workflow settings' }))
    expect(screen.queryByRole('button', { name: /Delete workflow/ })).toBeNull()
  })

  it('builds the canvas from a description through the planner', async () => {
    const sent = stubFetch({
      'POST /api/v1/plan': () =>
        jsonResponse({
          name: 'fix-and-test',
          steps: [
            { id: 'fix', prompt: 'Fix: {{task}}' },
            { id: 'test', command: 'npm test' },
          ],
          rationale: 'two steps',
          fallback: false,
        }),
    })
    renderAt('/workflows')
    await nameField()
    fireEvent.click(screen.getByRole('button', { name: 'Workflow settings' }))
    fireEvent.change(screen.getByPlaceholderText(/implement, run the tests/), { target: { value: 'fix it and test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Build workflow' }))
    await waitFor(async () => expect((await nameField()).value).toBe('fix-and-test'))
    expect(sentTo(sent, 'POST', '/api/v1/plan')[0]?.body).toEqual({ task: 'fix it and test' })
    // The planned chain is on the canvas: the YAML preview shows it as a graph.
    expect(document.querySelector('pre')?.textContent).toContain('command: npm test')
  })

  it('exports the canvas as <slug>.yaml, in the form Save writes', async () => {
    stubFetch()
    const blobs: Blob[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.push(b), 'blob:x'), revokeObjectURL: () => undefined }))
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    renderAt('/workflows/ship-it')
    await nameField()
    fireEvent.click(screen.getByRole('button', { name: 'Export YAML' }))
    expect(downloads).toEqual(['ship-it.yaml'])
    expect(await blobs[0]?.text()).toBe('name: ship-it\ndescription: Fix then review.\nskills:\n  - om-fix\n  - om-review\n')
  })
})

import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreeLifecycleConfigSchema, type ConfigResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { WorktreeLifecycleEditor } from './worktree-lifecycle-editor'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const config: ConfigResponse = { baseBranch: null, defaultRunner: 'claude', systemPrompt: null, defaultModels: {}, modelsLocked: false, maxParallel: 2, memoryLimitMb: null, worktreeRetention: 10, liveTitleUpdates: null, reviewGate: null,
  worktreeLifecycle: { afterCreate: [{ id: firstId, command: 'printf first', name: 'Prepare' }, { id: secondId, command: 'printf second' }], beforeRemove: [] }, worktreeLifecycleRevision: 'revision-1' }
let requests: { method: string; path: string; body?: Record<string, unknown> }[]
let conflict: boolean
let invalidPreview: boolean
beforeEach(() => {
  requests = []; conflict = false; invalidPreview = false
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    requests.push({ path, method, body })
    if (path.startsWith('/api/v1/worktree-lifecycle?')) return json({ worktrees: [] })
    if (path === '/api/v1/worktree-lifecycle/preview') {
      if (invalidPreview) return json({ error: 'Unknown template variable at position 8: unknown' }, 400)
      return json({ renderedCommand: body?.command, variables: { root_path: '/example/project', worktree_path: '/example/worktree', worktree_id: 'cez-example', task_id: 'example' }, cwd: '/example/worktree', illustrative: true })
    }
    if (path === '/api/v1/config' && method === 'PUT') {
      if (conflict) return json({ error: 'Worktree scripts changed; reload settings before saving' }, 409)
      return json({ ...config, worktreeLifecycle: body?.worktreeLifecycle, worktreeLifecycleRevision: 'revision-2' })
    }
    if (path === '/api/v1/config') return json(config)
    throw new Error(`Unexpected request ${method} ${path}`)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const mount = (value = config) => render(<QueryClientProvider client={createQueryClient()}><WorktreeLifecycleEditor config={value} /></QueryClientProvider>)
const command = (index: number) => screen.getByLabelText(`After worktree creation — command ${index}`) as HTMLTextAreaElement
const puts = () => requests.filter(request => request.method === 'PUT')

describe('Worktree lifecycle settings editor', () => {
  it('retains stable IDs when editing and reordering, validates previews, and saves both lists with revision', async () => {
    mount()
    fireEvent.change(command(1), { target: { value: 'printf edited\nprintf next' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move after worktree creation command 2 up' }))
    expect(command(1).value).toBe('printf second')
    fireEvent.click(screen.getByRole('button', { name: 'Save scripts' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    const body = puts()[0]!.body!
    expect(body.worktreeLifecycleRevision).toBe('revision-1')
    expect(worktreeLifecycleConfigSchema.parse(body.worktreeLifecycle)).toEqual({ afterCreate: [{ id: secondId, command: 'printf second' }, { id: firstId, name: 'Prepare', command: 'printf edited\nprintf next' }], beforeRemove: [] })
    expect(requests.filter(request => request.path.endsWith('/preview'))).toHaveLength(2)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Retry uses these commands'))
    expect(requests.some(request => request.path.endsWith('/actions'))).toBe(false)
  })

  it('inserts a selected token at the caret and returns focus to the command', async () => {
    mount()
    const editor = command(1)
    editor.focus(); editor.setSelectionRange(7, 12)
    fireEvent.click(screen.getAllByText('Variables')[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Insert root_path into after worktree creation command 1' }))
    expect(editor.value).toBe('printf {{ root_path }}')
    await waitFor(() => expect(document.activeElement).toBe(editor))
    expect(editor.selectionStart).toBe(editor.value.length)
  })

  it('keeps draft order and command on a stale save and never retries scripts implicitly', async () => {
    conflict = true; mount()
    fireEvent.change(command(1), { target: { value: 'repaired-command' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move after worktree creation command 1 down' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save scripts' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('reload settings'))
    expect(command(1).value).toBe('printf second')
    expect(command(2).value).toBe('repaired-command')
    expect(requests.some(request => request.path.includes('/actions'))).toBe(false)
  })

  it('shows unknown template validation next to its entry and sends no config write', async () => {
    invalidPreview = true; mount()
    fireEvent.change(command(1), { target: { value: 'echo {{ unknown }}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save scripts' }))
    await waitFor(() => expect(document.getElementById(`lifecycle-error-${firstId}`)?.textContent).toContain('Unknown template'))
    expect(command(1).getAttribute('aria-invalid')).toBe('true')
    expect(puts()).toHaveLength(0)
  })

  it('can explicitly clear both lists while preserving unrelated config on the wire', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Remove after worktree creation command 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove after worktree creation command 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save scripts' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeLifecycle: { afterCreate: [], beforeRemove: [] }, worktreeLifecycleRevision: 'revision-1' })
  })

  it('labels illustrative previews and never executes an operation', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Preview after worktree creation command 1' }))
    await waitFor(() => expect(screen.getByText('Example preview — illustrative values')).toBeTruthy())
    expect(screen.getByText('Working directory: /example/worktree')).toBeTruthy()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(puts()).toHaveLength(0)
  })

  it('does not save to another project if settings unmount during template validation', async () => {
    const originalFetch = globalThis.fetch
    let finishPreview: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/preview')) return new Promise<Response>(resolve => { finishPreview = resolve })
      return originalFetch(input, init)
    }))
    const view = mount()
    fireEvent.change(command(1), { target: { value: 'modified before leaving project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save scripts' }))
    await waitFor(() => expect(finishPreview).toBeDefined())
    view.unmount()
    await act(async () => { finishPreview!(new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})) })
    expect(puts()).toHaveLength(0)
  })

  it('new rows get different stable IDs and blank commands are rejected before network mutation', async () => {
    mount({ ...config, worktreeLifecycle: { afterCreate: [], beforeRemove: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Add setup command' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add cleanup command' }))
    const ids = [...document.querySelectorAll('textarea')].map(element => element.id)
    expect(new Set(ids).size).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save scripts' }))
    await act(async () => {})
    expect(screen.getAllByText('Command must not be blank')).toHaveLength(2)
    expect(puts()).toHaveLength(0)
    expect(requests.some(request => request.path.endsWith('/preview'))).toBe(false)
  })
})

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { QueuedEnginePicker, queuedEngineSelection } from './queued-engine-picker'

const run: ApiRun = {
  id: 'queued-1', title: 'Fix the error', workflow: 'quick-task', task: 'Fix the error', status: 'queued',
  createdAt: '2026-11-12T00:00:00Z', tokensUsed: 0, archived: false,
  runner: 'claude', model: 'opus', reasoningEffort: 'high', steps: [],
}
let posts: Array<{ url: string; body: unknown }>
function serve({ locked = false, conflict = false, codexDefault = '', namedCodex = false } = {}) {
  posts = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (init.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return conflict ? json({ error: 'run already started' }, 409) : json({ updated: true })
    }
    if (url.endsWith('/providers/status')) return json({ providers: ['claude', 'codex'].map(provider => ({ provider, status: namedCodex && provider === 'codex' ? 'disconnected' : 'connected', enabled: true })) })
    if (url.endsWith('/config')) return json({ defaultRunner: 'claude', defaultModels: { claude: 'opus', codex: codexDefault }, modelsLocked: locked })
    if (url.includes('/models?runner=')) {
      const runner = url.split('=').at(-1)
      return json({ runner, models: [{ id: runner === 'claude' ? 'opus' : 'gpt-future', label: runner === 'claude' ? 'Opus' : 'GPT future', description: '', reasoningEfforts: [{ id: 'high' }] }], source: 'live', stale: false })
    }
    if (url.endsWith('/workspace/agent-profiles')) return json({ editable: true, profileCapableProviders: ['claude', 'codex'], profiles: namedCodex ? [{ id: 'default', provider: 'codex', label: 'Default', configDir: '/codex', path: '/codex', exists: true, looksValid: true, isDefault: true, files: [] }, { id: 'work', provider: 'codex', label: 'Work', configDir: '/codex-work', path: '/codex-work', exists: true, looksValid: true, isDefault: false, files: [], status: { provider: 'codex', status: 'connected' } }] : [], selections: {}, defaults: {} })
    if (url.endsWith('/repo')) return json({ info: { root: '/repo', branch: 'main' } })
    return json({})
  }))
}
function show(value = run) {
  return render(<QueryClientProvider client={createQueryClient()}><QueuedEnginePicker run={value} /></QueryClientProvider>)
}
async function pick(label: string, text: string) {
  fireEvent.pointerDown(await screen.findByRole('button', { name: label }))
  let choice: HTMLElement | undefined
  await waitFor(() => {
    choice = screen.getAllByRole('menuitemradio').find(option => option.textContent?.toLowerCase().includes(text.toLowerCase()))
    expect(choice).toBeDefined()
  })
  fireEvent.click(choice!)
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('queued engine choice', () => {
  it('switches a never-started task without cancelling or sending a continuation', async () => {
    serve(); show()
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    await pick('Runner', 'codex')
    await pick('Model', 'GPT future')
    await pick('Effort', 'high')
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }))
    await waitFor(() => expect(posts).toEqual([{ url: '/api/v1/runs/queued-1/engine', body: { runner: 'codex', model: 'gpt-future', reasoningEffort: 'high' } }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('permits a runner change under native model lock without carrying the old model or effort', async () => {
    serve({ locked: true }); show()
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    await pick('Runner', 'codex')
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }))
    await waitFor(() => expect(posts[0]?.body).toEqual({ runner: 'codex' }))
  })
  it('sends the displayed configured model when switching agent without another model pick', async () => {
    serve({ codexDefault: 'gpt-future' }); show()
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    await pick('Runner', 'codex')
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }))
    await waitFor(() => expect(posts[0]?.body).toEqual({ runner: 'codex', model: 'gpt-future' }))
  })
  it('shows native auto for an unpinned queued task even if project defaults changed', async () => {
    serve(); show({ ...run, model: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toContain('auto'))
    expect(posts).toEqual([])
  })
  it('allows a named account when its provider default login is disconnected', async () => {
    serve({ namedCodex: true }); show()
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    await pick('Runner', 'Work')
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }))
    await waitFor(() => expect(posts[0]?.body).toEqual({ runner: 'codex', model: '', agentProfile: 'work' }))
  })
  it('keeps the error visible if the task starts before Save', async () => {
    serve({ conflict: true }); show()
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    await pick('Runner', 'codex')
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }))
    expect((await screen.findByRole('alert')).textContent).toContain('run already started')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('shows the pending continuation model and effort rather than the original run defaults', () => {
    const steps: ApiRun['steps'] = [
      { id: 'work', name: 'Work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'claude', sessionId: 's1', model: 'sonnet', profileId: 'work' },
      { id: 'continue-1', name: 'Continue', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0, reasoningEffort: 'medium' },
    ]
    expect(queuedEngineSelection({ ...run, steps })).toEqual({ model: 'sonnet', effort: 'medium', account: 'work' })
    expect(queuedEngineSelection({ ...run, agentProfile: 'another', steps })).toEqual({ model: 'opus', effort: 'medium', account: 'another' })
    steps[1] = { ...steps[1]!, freshSession: true, model: '' }
    expect(queuedEngineSelection({ ...run, steps })).toEqual({ model: '', effort: 'medium', account: undefined })
  })
  it('does not expose queued reassignment for a running task', () => {
    serve(); show({ ...run, status: 'running' })
    expect(screen.queryByRole('button', { name: 'Change agent' })).toBeNull()
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { ModelPicker } from './manager-pickers'
import { RunEnginePills } from '../task-thread/run-engine'

const state = vi.hoisted(() => ({ locked: false }))
vi.mock('@/api/managers', () => ({ useManagers: () => ({ data: { managers: [], modelsLocked: state.locked } }) }))
vi.mock('@/api/agent-accounts', () => ({ useAgentAccounts: () => ({ accounts: [] }) }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { defaultRunner: 'codex' } }),
  useProjects: () => ({ data: { projects: [] } }),
  useConfig: () => ({ data: { defaultRunner: 'codex' } }),
  useAgentProfiles: () => ({ data: { profiles: [] } }),
  useProviderStatus: () => ({ data: { providers: ['claude', 'codex', 'opencode'].map(provider => ({ provider, enabled: true, status: 'connected' })) } }),
  useRunnerModels: (runner: string) => ({ data: { runner, models: [
    { id: 'sol', label: 'Sol', description: '', reasoningEfforts: [{ id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] },
    { id: 'small', label: 'Small', description: '', reasoningEfforts: [{ id: 'low' }] },
  ], source: 'live', stale: false } }),
}))
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })
beforeEach(() => {
  state.locked = false
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function open() { fireEvent.pointerDown(screen.getByRole('button', { name: 'Model and effort' })); await screen.findByRole('menu') }

describe('manager effort', () => {
  it('offers discovered Codex levels and saves effort without changing model or account', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="sol" effort="medium" onChange={patch} nextTurn />)
    expect(screen.getByRole('button', { name: 'Model and effort' }).textContent).toContain('Medium')
    await open()
    expect(screen.queryByRole('menuitemradio', { name: 'Low' })).toBeNull()
    expect(screen.getByText('Changes apply to the next turn.')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Xhigh' }))
    expect(patch).toHaveBeenCalledWith({ effort: 'xhigh' })
  })
  it('clears effort to native default explicitly', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="sol" effort="high" onChange={patch} />)
    await open(); fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }))
    expect(patch).toHaveBeenCalledWith({ effort: null })
  })
  it('keeps Default available to clear a saved effort even without discovered model levels', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" effort="medium" onChange={patch} />)
    await open()
    expect(screen.queryByRole('menuitemradio', { name: 'High' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }))
    expect(patch).toHaveBeenCalledWith({ effort: null })
  })
  it('clears incompatible effort when a model changes', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="sol" effort="xhigh" onChange={patch} />)
    await open(); fireEvent.click(screen.getByRole('menuitemradio', { name: 'Small' }))
    expect(patch).toHaveBeenCalledWith({ model: 'small', effort: null })
  })
  it('leaves compatible effort untouched when selecting the same model', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="sol" effort="high" onChange={patch} />)
    await open(); fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sol' }))
    expect(patch).toHaveBeenCalledWith({ model: 'sol' })
  })
  it('does not erase saved effort when reselecting an undiscovered current model', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="custom" effort="high" onChange={patch} />)
    await open(); fireEvent.click(screen.getByRole('menuitemradio', { name: 'custom' }))
    expect(patch).toHaveBeenCalledWith({ model: 'custom' })
  })
  it('clears runner-specific pins together on an agent change', async () => {
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="sol" effort="high" onChange={patch} />)
    await open(); fireEvent.click(screen.getByRole('menuitemradio', { name: 'claude' }))
    expect(patch).toHaveBeenCalledWith({ runner: 'claude', model: null, effort: null, agentProfile: null })
  })
  it('respects the workspace native-settings lock', async () => {
    state.locked = true
    const patch = vi.fn()
    render(<ModelPicker runner="codex" model="sol" effort="high" onChange={patch} />)
    expect(screen.getByRole('button', { name: 'Model and effort' }).textContent).toContain('Native settings')
    await open()
    expect(screen.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Sol' }).getAttribute('aria-disabled')).toBe('true')
    expect(patch).not.toHaveBeenCalled()
  })
  it.each([{ runner: 'opencode', model: 'sol' }, { runner: 'codex', model: 'custom' }, { runner: 'codex' }])('does not invent effort choices for %j', async props => {
    render(<ModelPicker {...props} onChange={vi.fn()} />)
    await open()
    expect(screen.queryByRole('menuitemradio', { name: 'High' })).toBeNull()
  })
})

it('shows the active task turn’s recorded effort as read-only, even when the run default differs', async () => {
  const run: ApiRun = { id: 'r1', title: 'Task', task: 'Task', workflow: 'quick-task', status: 'running', createdAt: '2026-11-12', tokensUsed: 0, archived: false,
    runner: 'codex', model: 'sol', reasoningEffort: 'low', steps: [{ id: 'continue-1', name: 'Continue', kind: 'agent', status: 'running', tokensUsed: 0, iterations: 1, sessionId: 's1', backend: 'codex', reasoningEffort: 'high' }] }
  render(<RunEnginePills run={run} />)
  await waitFor(() => expect(screen.getByLabelText('Effort').textContent).toContain('high'))
  fireEvent.pointerDown(screen.getByLabelText('Effort'))
  expect(screen.queryByRole('menuitemradio')).toBeNull()
})

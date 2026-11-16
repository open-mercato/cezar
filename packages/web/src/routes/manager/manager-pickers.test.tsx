import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountPicker, ModelPicker, TaskRunnerPicker } from './manager-pickers'

vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { defaultRunner: 'claude' } }),
  useProviderStatus: () => ({ data: { providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'pi', status: 'connected', enabled: true },
  ] } }),
  useRunnerModels: () => ({ data: undefined }),
  useAgentProfiles: () => ({ data: { defaults: { codex: 'work' }, profiles: [
    { provider: 'codex', id: 'default', label: 'Default' },
    { provider: 'codex', id: 'work', label: 'Work' },
    { provider: 'claude', id: 'personal', label: 'Personal' },
  ] } }),
}))

afterEach(cleanup)

describe('manager agent and account selection', () => {
  it('offers accounts in the model menu on the selected agent', async () => {
    const onChange = vi.fn()
    render(<ModelPicker runner="codex" agentProfile="work" onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model and effort' }))
    const work = await screen.findByRole('menuitemradio', { name: 'Work' })
    expect(work.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('menuitemradio', { name: 'Personal' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }))
    expect(onChange).toHaveBeenCalledWith({ agentProfile: 'default' })
  })

  it('drops the previous model and account when switching agents', async () => {
    const onChange = vi.fn()
    render(<ModelPicker runner="claude" model="opus" agentProfile="personal" onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model and effort' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'codex' }))
    expect(onChange).toHaveBeenCalledWith({ runner: 'codex', model: null, agentProfile: null })
  })

  it('shows the workspace account and lets the user return to automatic account selection', async () => {
    const onChange = vi.fn()
    render(<AccountPicker runner="codex" agentProfile="default" onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent account' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Use workspace default (Work)' }))
    expect(onChange).toHaveBeenCalledWith({ agentProfile: null })
  })

  it('labels an inherited account using the workspace default', () => {
    render(<AccountPicker runner="codex" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Agent account' }).textContent).toContain('Work')
  })
})

describe('manager task agent selection', () => {
  it('offers Automatic and usable task backends, including Pi', async () => {
    const onChange = vi.fn()
    render(<TaskRunnerPicker onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent for new tasks' }))
    expect((await screen.findByRole('menuitemradio', { name: 'Automatic' })).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'pi' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'codex' }))
    expect(onChange).toHaveBeenCalledWith({ taskRunner: 'codex' })
  })

  it('can clear a pinned backend back to Automatic', async () => {
    const onChange = vi.fn()
    render(<TaskRunnerPicker taskRunner="codex" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Agent for new tasks' }).textContent).toContain('Tasks: codex')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent for new tasks' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Automatic' }))
    expect(onChange).toHaveBeenCalledWith({ taskRunner: null })
  })
})

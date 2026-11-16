import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountPicker, ManagerRunnerPicker, ModelPicker, TaskRunnerPicker } from './manager-pickers'

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
    { provider: 'claude', id: 'second', label: 'Second' },
  ] } }),
}))

afterEach(cleanup)

describe('manager agent and account selection', () => {
  it('keeps the dialog agent picker restricted and clears incompatible model/account pins', async () => {
    const onChange = vi.fn()
    render(<ManagerRunnerPicker runner="claude" onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Manager agent' }))
    const codex = await screen.findByRole('menuitemradio', { name: 'codex' })
    expect(screen.queryByRole('menuitemradio', { name: 'pi' })).toBeNull()
    fireEvent.click(codex)
    expect(onChange).toHaveBeenCalledWith({ runner: 'codex', model: null, agentProfile: null })
  })

  it('offers model and effort alone when the dialog has separate agent/account fields', async () => {
    const onChange = vi.fn()
    render(<ModelPicker runner="claude" modelOnly onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model and effort' }))
    expect(await screen.findByRole('menuitemradio', { name: 'High' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'codex' })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: 'Use workspace default (Default)' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
    expect(onChange).toHaveBeenCalledWith({ effort: 'high' })
  })

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
  it('offers Automatic and account checkboxes for usable backends, including Pi', async () => {
    const onChange = vi.fn()
    render(<TaskRunnerPicker onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent for new tasks' }))
    expect((await screen.findByRole('menuitemcheckbox', { name: 'Automatic' })).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'pi · Default' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'codex · Work' }))
    expect(onChange).toHaveBeenCalledWith({ taskRunner: null, taskAgents: [{ runner: 'codex', agentProfile: 'work' }] })
  })

  it('keeps two Claude accounts and one Codex account selected even before saves return', async () => {
    const onChange = vi.fn()
    render(<TaskRunnerPicker onChange={onChange} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent for new tasks' }))
    for (const name of ['claude · Personal', 'claude · Second', 'codex · Work']) {
      fireEvent.click(await screen.findByRole('menuitemcheckbox', { name }))
    }
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ taskRunner: null, taskAgents: [
      { runner: 'claude', agentProfile: 'personal' }, { runner: 'claude', agentProfile: 'second' }, { runner: 'codex', agentProfile: 'work' },
    ] })
    expect(screen.getByRole('menuitemcheckbox', { name: 'claude · Personal' }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-slot="manager-task-runner-picker"]')?.textContent).toContain('3 accounts')
  })

  it('can clear a legacy pinned backend back to Automatic', async () => {
    const onChange = vi.fn()
    render(<TaskRunnerPicker taskRunner="codex" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Agent for new tasks' }).textContent).toContain('Tasks: codex')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent for new tasks' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Automatic' }))
    expect(onChange).toHaveBeenCalledWith({ taskRunner: null, taskAgents: null })
  })
})

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HarnessRoles } from '@open-mercato/cezar-api-client'

import { HarnessPanel, HarnessSetupDialog, ModelPickerPill } from './new-task-harness'
import type {
  HarnessModelOption,
} from './new-task-harness-form'

/**
 * The Multi-model tab's role-based surface (user feedback 2026-07-24): pick models for
 * roles — Orchestrator, Implementer, 2–5 unique Reviewers spanning two families — plus the
 * blocking setup dialog when the workspace cannot field a council. Presentational; the route
 * owns data and drafts.
 */

const options: HarnessModelOption[] = [
  { runner: 'claude', model: 'sonnet', label: 'sonnet', family: 'anthropic' },
  { runner: 'claude', model: 'opus', label: 'opus', family: 'anthropic' },
  { runner: 'codex', model: '', label: 'auto', family: 'openai' },
]

const roles: HarnessRoles = {
  orchestrator: { runner: 'claude', model: 'sonnet' },
  implementer: { runner: 'codex', model: '' },
  reviewers: [
    { runner: 'claude', model: 'opus' },
    { runner: 'codex', model: '' },
  ],
}

const noop = () => {}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
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
  cleanup()
  vi.unstubAllGlobals()
})

describe('HarnessPanel (role-based)', () => {
  it('uses one tab stop per radio group and supports arrow, Home and End keys', () => {
    const onMode = vi.fn()
    const onSkillProfile = vi.fn()
    const onRoles = vi.fn()
    render(<HarnessPanel mode="fix-issue" onMode={onMode} onSkillProfile={onSkillProfile} roles={roles} onRoles={onRoles} options={options} />)
    for (const group of screen.getAllByRole('radiogroup')) {
      expect(within(group).getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toHaveLength(1)
    }
    const mode = screen.getByRole('radio', { name: /fix an issue/i })
    mode.focus()
    fireEvent.keyDown(mode, { key: 'ArrowRight' })
    expect(onMode).toHaveBeenLastCalledWith('implement-feature')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /build a feature/i }))

    const profile = screen.getByRole('radio', { name: /generic project/i })
    fireEvent.keyDown(profile, { key: 'ArrowUp' })
    expect(onSkillProfile).toHaveBeenLastCalledWith('open-mercato')

    const effort = within(screen.getByRole('radiogroup', { name: 'Implementer effort' }))
    fireEvent.keyDown(effort.getByRole('radio', { name: 'auto' }), { key: 'End' })
    expect(onRoles).toHaveBeenLastCalledWith({ ...roles, implementer: { ...roles.implementer, effort: 'max' } })
    fireEvent.keyDown(effort.getByRole('radio', { name: 'max' }), { key: 'Home' })
    expect(onRoles).toHaveBeenLastCalledWith({ ...roles, implementer: { ...roles.implementer, effort: undefined } })
  })

  it('disables Add reviewer when every available reviewer is already seated', () => {
    const seated = { ...roles, reviewers: [...roles.reviewers, { runner: 'claude' as const, model: 'sonnet' }] }
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={seated} onRoles={noop} options={options} />)
    expect(screen.getByRole('button', { name: /add reviewer/i }).hasAttribute('disabled')).toBe(true)
  })

  it('offers the two modes by plain names and reports a pick', () => {
    const onMode = vi.fn()
    render(<HarnessPanel mode="fix-issue" onMode={onMode} roles={roles} onRoles={noop} options={options} />)
    fireEvent.click(screen.getByRole('radio', { name: /build a feature/i }))
    expect(onMode).toHaveBeenCalledWith('implement-feature')
  })

  it('defaults to generic skills and reports an explicit Open Mercato profile pick', () => {
    const onSkillProfile = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        skillProfile="generic"
        onSkillProfile={onSkillProfile}
        roles={roles}
        onRoles={noop}
        options={options}
      />,
    )
    expect(
      screen.getByRole('radio', { name: /generic project/i }).getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: /open mercato/i }))
    expect(onSkillProfile).toHaveBeenCalledWith('open-mercato')
    expect(screen.getByText(/requirement brief/i)).toBeTruthy()
  })

  it('renders one picker per role with the current models', () => {
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={roles} onRoles={noop} options={options} />)
    expect(screen.getByRole('button', { name: 'Orchestrator model' }).textContent).toContain('claude · sonnet')
    expect(screen.getByRole('button', { name: 'Implementer model' }).textContent).toContain('codex · auto')
    expect(screen.getByRole('button', { name: 'Reviewer 1 model' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reviewer 2 model' })).toBeTruthy()
  })

  it('adds a reviewer up to five and removes down to two', () => {
    const onRoles = vi.fn()
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={roles} onRoles={onRoles} options={options} />)
    fireEvent.click(screen.getByRole('button', { name: /add reviewer/i }))
    expect(onRoles).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: [...roles.reviewers, { runner: 'claude', model: 'sonnet' }] }),
    )
    expect(screen.queryByRole('button', { name: /remove reviewer/i })).toBeNull()
  })

  it('surfaces the multi-model rule when the selection breaks it', () => {
    const single: HarnessRoles = {
      ...roles,
      reviewers: [
        { runner: 'claude', model: 'opus' },
        { runner: 'claude', model: 'haiku' },
      ],
    }
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={single} onRoles={noop} options={options} />)
    expect(screen.getByText(/at least two different model families/i)).toBeTruthy()
  })

  it('always states the stage-only contract', () => {
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={roles} onRoles={noop} options={options} />)
    expect(screen.getByText(/cannot commit, push, or open a PR/i)).toBeTruthy()
  })
})

describe('HarnessSetupDialog (need-more-models)', () => {
  it('names the lone family and routes to configuration or back to Task', () => {
    const onConfigure = vi.fn()
    const onBackToTask = vi.fn()
    render(
      <HarnessSetupDialog families={['anthropic']} onConfigure={onConfigure} onBackToTask={onBackToTask} onClose={noop} />,
    )
    expect(screen.getByText(/needs more than one model/i)).toBeTruthy()
    expect(screen.getByText('anthropic')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /configure models/i }))
    expect(onConfigure).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /back to task/i }))
    expect(onBackToTask).toHaveBeenCalled()
  })
})

describe('ModelPickerPill (grouped + searchable, 2026-07-24)', () => {
  const many: HarnessModelOption[] = [
    ...options,
    { runner: 'opencode', model: 'deepseek/deepseek-v4', label: 'deepseek-v4', family: 'deepseek' },
    { runner: 'opencode', model: 'openai/gpt-5.1', label: 'gpt-5.1', family: 'openai' },
  ]

  it('groups the menu by provider family and picks a model', () => {
    const onPick = vi.fn()
    render(
      <ModelPickerPill
        slot="test-picker"
        ariaLabel="Orchestrator model"
        value={{ runner: 'claude', model: 'sonnet' }}
        options={many}
        onPick={onPick}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator model' }))
    expect(screen.getByText('anthropic')).toBeTruthy()
    expect(screen.getByText('deepseek')).toBeTruthy()
    fireEvent.click(screen.getByText(/deepseek-v4/))
    expect(onPick).toHaveBeenCalledWith({ runner: 'opencode', model: 'deepseek/deepseek-v4' })
  })

  it('filters the menu by search', () => {
    render(
      <ModelPickerPill
        slot="test-picker"
        ariaLabel="Reviewer 1 model"
        value={{ runner: 'claude', model: 'sonnet' }}
        options={many}
        onPick={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer 1 model' }))
    fireEvent.change(screen.getByPlaceholderText(/search models/i), { target: { value: 'deepseek' } })
    expect(screen.getByText(/deepseek-v4/)).toBeTruthy()
    expect(screen.queryByText('claude · opus')).toBeNull()
  })

  it('shows only literal model matches with real catalog descriptions and resets the scroll', () => {
    const catalog: HarnessModelOption[] = [
      { runner: 'claude', model: 'sonnet', label: 'Sonnet', family: 'anthropic', desc: 'Sonnet 5 · Efficient for routine tasks' },
      { runner: 'claude', model: 'opus[1m]', label: 'Opus (1M context)', family: 'anthropic', desc: 'Opus 5.5 with 1M context · Best for everyday coding' },
      { runner: 'codex', model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', family: 'openai', desc: 'Latest workhorse model for coding and everyday work' },
      { runner: 'opencode', model: 'deepseek/deepseek-v4', label: 'DeepSeek V4', family: 'deepseek' },
    ]
    render(<ModelPickerPill slot="test-picker" ariaLabel="Reviewer 1 model" value={{ runner: 'claude', model: 'sonnet' }} options={catalog} onPick={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer 1 model' }))
    const input = screen.getByPlaceholderText(/search models/i)
    const list = screen.getByRole('listbox')
    list.scrollTop = 200
    fireEvent.change(input, { target: { value: 'deepseek' } })

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toMatch(/DeepSeek.*deepseek-v4/i)
    expect(screen.queryByText('anthropic')).toBeNull()
    expect(screen.queryByText('openai')).toBeNull()
    expect(list.scrollTop).toBe(0)

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getAllByRole('option')).toHaveLength(catalog.length)
  })

  it('selects a filtered match with Enter and reports an empty search without unrelated rows', async () => {
    const onPick = vi.fn()
    render(<ModelPickerPill slot="test-picker" ariaLabel="Reviewer 1 model" value={{ runner: 'claude', model: 'sonnet' }} options={many} onPick={onPick} onAddModels={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer 1 model' }))
    const input = screen.getByPlaceholderText(/search models/i)
    fireEvent.change(input, { target: { value: 'deepseek solar' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('Nothing matches.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /add more models/i })).toBeTruthy()

    fireEvent.change(input, { target: { value: 'deepseek' } })
    await waitFor(() => expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith({ runner: 'opencode', model: 'deepseek/deepseek-v4' })
  })
})

describe('harness presets (2026-07-24)', () => {
  const preset = { id: 'p1', name: 'Cheap council', roles }

  it('applies a preset from its chip and marks the active one', () => {
    const onApply = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={roles}
        onRoles={noop}
        options={options}
        presets={[preset, { id: 'p2', name: 'Other', roles: { ...roles, reviewers: [...roles.reviewers].reverse() } }]}
        onApplyPreset={onApply}
        onSavePreset={noop}
        onDeletePreset={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'Cheap council' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }))
  })

  it('saves the current lineup under a typed name', () => {
    const onSave = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={roles}
        onRoles={noop}
        options={options}
        presets={[]}
        onApplyPreset={noop}
        onSavePreset={onSave}
        onDeletePreset={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }))
    fireEvent.change(screen.getByPlaceholderText(/preset name/i), { target: { value: 'My trio' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledWith('My trio')
  })

  it('deletes a preset from its chip', () => {
    const onDelete = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={roles}
        onRoles={noop}
        options={options}
        presets={[preset]}
        onApplyPreset={noop}
        onSavePreset={noop}
        onDeletePreset={onDelete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset Cheap council' }))
    expect(onDelete).toHaveBeenCalledWith('p1')
  })
})

describe('per-role reasoning effort + add-models (2026-07-24)', () => {
  it('changes a role effort through its dial', () => {
    const onRoles = vi.fn()
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={roles} onRoles={onRoles} options={options} />)
    const dial = screen.getByRole('radiogroup', { name: 'Implementer effort' })
    fireEvent.click(within(dial).getByRole('radio', { name: 'max' }))
    expect(onRoles).toHaveBeenCalledWith(
      expect.objectContaining({ implementer: { runner: 'codex', model: '', effort: 'max' } }),
    )
  })

  it('shows the whole effort scale, with the current step marked', () => {
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={{ ...roles, implementer: { runner: 'codex', model: '', effort: 'high' } }}
        onRoles={noop}
        options={options}
      />,
    )
    const dial = screen.getByRole('radiogroup', { name: 'Implementer effort' })
    expect(within(dial).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'auto',
      'low',
      'med',
      'high',
      'max',
    ])
    expect(within(dial).getByRole('radio', { name: 'high' }).getAttribute('aria-checked')).toBe('true')
  })

  it('states each picked model provider family beside its pill', () => {
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={roles} onRoles={noop} options={options} />)
    expect(screen.getAllByText('anthropic').length).toBeGreaterThan(0)
    expect(screen.getAllByText('openai').length).toBeGreaterThan(0)
  })

  it('always offers a way to add providers or models', () => {
    const onAddModels = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={roles}
        onRoles={noop}
        options={options}
        onAddModels={onAddModels}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /add providers/i }))
    expect(onAddModels).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator model' }))
    fireEvent.change(screen.getByPlaceholderText(/search models/i), { target: { value: 'zzz-no-match' } })
    fireEvent.click(screen.getByRole('button', { name: /add more models/i }))
    expect(onAddModels).toHaveBeenCalledTimes(2)
  })
})

describe('preset overflow + explicit cap (2026-07-24)', () => {
  const manyPresets = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, roles }))

  it('renders 3 chips inline and the rest behind a "+N more" menu', () => {
    const onApply = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={{ ...roles, orchestrator: { runner: 'claude', model: 'haiku' } }}
        onRoles={noop}
        options={options}
        presets={manyPresets}
        onApplyPreset={onApply}
        onSavePreset={noop}
        onDeletePreset={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'P0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'P2' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'P5' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /4 more/i }))
    fireEvent.click(screen.getByRole('button', { name: 'P5' }))
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 'p5' }))
  })

  it('deletes from the overflow menu too', () => {
    const onDelete = vi.fn()
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={{ ...roles, orchestrator: { runner: 'claude', model: 'haiku' } }}
        onRoles={noop}
        options={options}
        presets={manyPresets}
        onApplyPreset={noop}
        onSavePreset={noop}
        onDeletePreset={onDelete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /4 more/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset P6' }))
    expect(onDelete).toHaveBeenCalledWith('p6')
  })

  it('refuses a NEW name at the cap with guidance, but allows replacing by name', () => {
    const onSave = vi.fn()
    const full = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, roles }))
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={noop}
        roles={{ ...roles, orchestrator: { runner: 'claude', model: 'haiku' } }}
        onRoles={noop}
        options={options}
        presets={full}
        onApplyPreset={noop}
        onSavePreset={onSave}
        onDeletePreset={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }))
    fireEvent.change(screen.getByPlaceholderText(/preset name/i), { target: { value: 'Brand new' } })
    expect(screen.getByText(/12 presets max/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/preset name/i), { target: { value: 'P4' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledWith('P4')
  })
})

describe('free-tier reviewer warning', () => {
  const noop = () => {}

  it('warns in the lineup when a reviewer is a free-tier model', () => {
    const withFree: HarnessRoles = {
      ...roles,
      reviewers: [
        { runner: 'claude', model: 'opus' },
        { runner: 'opencode', model: 'opencode/mimo-v2.5-free' },
      ],
    }
    render(
      <HarnessPanel mode="fix-issue" onMode={noop} roles={withFree} onRoles={noop} options={options} />,
    )
    const warning = document.querySelector('[data-slot="harness-free-tier-warning"]')
    expect(warning).not.toBeNull()
    expect(warning!.textContent).toContain('mimo-v2.5-free')
  })

  it('stays silent for an all-paid lineup', () => {
    render(<HarnessPanel mode="fix-issue" onMode={noop} roles={roles} onRoles={noop} options={options} />)
    expect(document.querySelector('[data-slot="harness-free-tier-warning"]')).toBeNull()
  })
})

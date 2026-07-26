import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HarnessRoles } from '@/api/types'

import { HarnessPanel, HarnessSetupDialog, ModelPickerPill } from './new-task-harness'
import type { HarnessModelOption } from './new-task-form'

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
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
  // cmdk sizes its list with a ResizeObserver; jsdom has none and never resizes anything
  // (the command-palette test's stub, verbatim).
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
  it('offers the two modes by plain names and reports a pick', () => {
    const onMode = vi.fn()
    render(<HarnessPanel mode="fix-issue" onMode={onMode} roles={roles} onRoles={noop} options={options} />)
    fireEvent.click(screen.getByRole('radio', { name: /build a feature/i }))
    expect(onMode).toHaveBeenCalledWith('implement-feature')
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
    // With exactly two reviewers there is no remove affordance — two is the floor.
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
    // Family group headings render.
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
    // Current roles deep-equal p1 → its chip reads as active.
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
    fireEvent.click(screen.getByRole('button', { name: 'Implementer effort' }))
    fireEvent.click(screen.getByRole('option', { name: /max/i }))
    expect(onRoles).toHaveBeenCalledWith(
      expect.objectContaining({ implementer: { runner: 'codex', model: '', effort: 'max' } }),
    )
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
    // Panel-level affordance — a real button in the lineup header, not a footnote.
    fireEvent.click(screen.getByRole('button', { name: /add providers/i }))
    expect(onAddModels).toHaveBeenCalledTimes(1)
    // …and one pinned inside every model menu, immune to search filtering.
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
    // Reusing an existing name replaces in place — allowed at the cap.
    fireEvent.change(screen.getByPlaceholderText(/preset name/i), { target: { value: 'P4' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledWith('P4')
  })
})

describe('free-tier reviewer warning', () => {
  const noop = () => {}

  it('warns in the lineup when a reviewer is a free-tier model', () => {
    // Live failure: mimo-v2.5-free burned two 60-minute review budgets and the
    // council lost that voice. Advisory only — it must not block Start.
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

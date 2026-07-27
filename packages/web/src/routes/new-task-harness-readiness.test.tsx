import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HarnessModel, HarnessRoles } from '@open-mercato/cezar-api-client'

import { buildCreateRunBody } from './new-task-form'
import { humanReadinessError } from './new-task-harness'
import { HarnessPanel, HarnessSetupDialog } from './new-task-harness'

const options = [
  { runner: 'claude' as const, model: 'sonnet', label: 'sonnet', family: 'anthropic' },
  { runner: 'codex' as const, model: '', label: 'auto', family: 'openai' },
]

const roles: HarnessRoles = {
  orchestrator: { runner: 'claude', model: 'sonnet' },
  implementer: { runner: 'codex', model: '' },
  reviewers: [
    { runner: 'claude', model: 'sonnet' },
    { runner: 'codex', model: '' },
  ],
}

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

function panel(models: HarnessModel[] = []) {
  render(
    <HarnessPanel
      mode="implement-feature"
      onMode={() => {}}
      probe={{
        profile: 'custom',
        ready: models.length > 0 && models.every((model) => model.readiness === 'ready'),
        reason: models.some((model) => model.readiness !== 'ready')
          ? 'Every selected model must be verified.'
          : undefined,
        models,
      }}
      roles={roles}
      onRoles={() => {}}
      options={options}
    />,
  )
}

/**
 * The named execution profiles were removed from the composer (user feedback 2026-07-27):
 * the lineup IS the choice. These tests pin the two things that removal must not break —
 * the picker never comes back, and the readiness evidence behind the Start gate stays visible.
 */
describe('multi-model start surface', () => {
  it('offers no execution-profile picker — only the custom lineup', () => {
    panel()

    expect(screen.queryByRole('radiogroup', { name: 'Harness execution profile' })).toBeNull()
    expect(screen.queryByText('Execution profile')).toBeNull()
    for (const label of [
      'Claude solo',
      'Worker offload',
      'Review council',
      'Council + worker',
      'High assurance',
      'Custom lineup',
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it('always reveals every role picker', () => {
    panel()

    expect(screen.getByRole('button', { name: 'Orchestrator model' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Implementer model' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reviewer 1 model' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reviewer 2 model' })).not.toBeNull()
  })

  it('never paints unknown or missing model readiness as success', () => {
    panel([
      {
        id: 'claude',
        roles: ['host', 'reviewer'],
        readiness: 'ready',
        readinessDetail: 'fresh round-trip',
      },
      {
        id: 'kimi',
        roles: ['reviewer'],
        readiness: 'unknown',
        readinessDetail: 'probe pending',
      },
      {
        id: 'mimo',
        roles: ['reviewer'],
        readiness: 'missing',
        readinessDetail: 'adapter missing',
      },
    ])

    const rowFor = (id: string) => screen.getByText(id).closest('div') as HTMLElement
    expect(rowFor('claude').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe(
      'success',
    )
    expect(rowFor('kimi').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe(
      'pending',
    )
    expect(rowFor('mimo').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe(
      'danger',
    )
    // Once in the card header, once in the blocking footer — the lineup is not startable.
    expect(screen.getAllByText('Every selected model must be verified.')).toHaveLength(2)
  })

  it('serializes the lineup, never a profile', () => {
    const payload = buildCreateRunBody({
      task: 'Build the billing module.',
      source: { source: 'workflow', ref: 'harness-implement-feature' },
      model: '',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 1,
      images: [],
      harnessRoles: roles,
    })

    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      task: 'Build the billing module.',
      workflow: 'harness-implement-feature',
      harness: { roles },
    })
  })
})


/**
 * Review finding (2026-07-27): the dialog's `families` came from the WHOLE
 * option roster, advisors included, while the thing that actually blocks —
 * `defaultHarnessRoles` — only counts runner-backed options. A workspace with
 * claude plus two configured advisors therefore hit the `families.length !== 1`
 * branch and was told "No models are available yet", which is both false and
 * points at the wrong fix.
 */
describe('harness setup dialog copy', () => {
  const open = (families: string[], advisorFamilies: string[] = []) =>
    render(
      <HarnessSetupDialog
        families={families}
        advisorFamilies={advisorFamilies}
        onConfigure={() => {}}
        onBackToTask={() => {}}
        onClose={() => {}}
      />,
    )

  it('names the real gap when advisors exist but only one runner family does', () => {
    open(['anthropic'], ['moonshot', 'zhipu'])

    expect(screen.getByText(/needs a second agent backend/i)).not.toBeNull()
    expect(screen.getByText(/2 configured reviewers/i)).not.toBeNull()
    expect(screen.getByText(/moonshot, zhipu/)).not.toBeNull()
    expect(screen.queryByText(/No models are available yet/i)).toBeNull()
  })

  it('keeps the one-family message when there are no advisors', () => {
    open(['anthropic'])

    expect(screen.getByText(/Only/)).not.toBeNull()
    expect(screen.queryByText(/No models are available yet/i)).toBeNull()
  })

  it('says nothing is available only when nothing is', () => {
    open([])

    expect(screen.getByText(/No models are available yet/i)).not.toBeNull()
  })
})


/**
 * Composer findings D1–D3 (review 2026-07-27).
 */
describe('composer readiness surface', () => {
  const failing: HarnessModel[] = [
    { id: 'claude/sonnet', roles: ['orchestrator'], readiness: 'ready', readinessDetail: 'round-trip ok' },
    {
      id: 'codex/auto',
      roles: ['implementer'],
      readiness: 'failed',
      readinessDetail:
        'codex exec exited 1: ","status":400,"error":{"type":"invalid_request_error","message":"The \'\' model is not supported when using Codex with a ChatGPT account."}} ERROR: {"type":"error","status":400}',
    },
  ]

  it('puts the readiness verdict on the model pill itself', () => {
    panel(failing)

    const implementer = screen.getByRole('button', { name: 'Implementer model' })
    expect(implementer.getAttribute('data-readiness')).toBe('failed')
    expect(
      screen.getByRole('button', { name: 'Orchestrator model' }).getAttribute('data-readiness'),
    ).toBe('ready')
  })

  it('summarises a provider failure instead of printing its raw JSON', () => {
    panel(failing)

    expect(screen.getByText(/pick a named model/i)).not.toBeNull()
    // The raw text is kept, but behind a disclosure rather than in the row.
    const details = document.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.textContent).toContain('invalid_request_error')
  })

  it('offers a way out of a failed binding', () => {
    render(
      <HarnessPanel
        mode="fix-issue"
        onMode={() => {}}
        probe={{ profile: 'custom', ready: false, reason: 'not ready', models: failing }}
        roles={roles}
        onRoles={() => {}}
        options={options}
        onAddModels={() => {}}
      />,
    )

    expect(document.querySelector('[data-slot="harness-fix-bindings"]')).not.toBeNull()
  })
})

describe('humanReadinessError', () => {
  it.each([
    ["codex exec exited 1: The '' model is not supported when using Codex with a ChatGPT account.", /pick a named model/i],
    ['request failed with status 401 unauthorized', /re-authenticate/i],
    ['429 rate limit exceeded', /rate-limiting/i],
    ['spawn codex ENOENT', /not installed/i],
    ['connect ECONNREFUSED 127.0.0.1:4096', /could not be reached/i],
    ['adapter missing', /no usable binding/i],
  ])('summarises %s', (detail, expected) => {
    expect(humanReadinessError(detail)).toMatch(expected)
  })

  it('never returns a wall of text for an unrecognised failure', () => {
    const long = `${'x'.repeat(400)}. tail`
    expect(humanReadinessError(long).length).toBeLessThanOrEqual(140)
  })
})

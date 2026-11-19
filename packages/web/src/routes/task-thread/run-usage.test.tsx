import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { LIVE_USAGE_STORAGE_KEY } from '@/lib/live-usage-pref'

import { RunUsage } from './run-usage'

beforeEach(() => {
  // Radix's tooltip arrow measures itself with a ResizeObserver; jsdom has no layout observer.
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.removeItem(LIVE_USAGE_STORAGE_KEY)
})

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status,
  createdAt: '2026-07-14T12:00:00.000Z',
  tokensUsed: 27_000,
  inputTokens: 24_600,
  outputTokens: 2_400,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Stubs fetch and lets a test override specific paths; everything else answers `{}`. */
function stubFetch(overrides: Record<string, () => Response> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const override = overrides[path]
      if (override) return override()
      if ((init.method ?? 'GET') === 'GET' && path === '/api/v1/runs') return jsonResponse([])
      return jsonResponse({})
    }),
  )
}

function renderUsage(record: ApiRun, continuationEngine?: ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <RunUsage run={record} continuationEngine={continuationEngine} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const usage = () => document.querySelector('[data-slot="run-usage"]') as HTMLElement
/** Opens the usage chip's popover — its content is not in the DOM until it does. */
const openDetails = async () => {
  fireEvent.click(within(usage()).getByRole('button', { name: /^Agent:/ }))
  return screen.findByRole('dialog')
}
/** The chip's tooltip text — shown on keyboard focus as well as hover. */
async function tooltipOf(trigger: HTMLElement): Promise<string | null> {
  fireEvent.focus(trigger)
  return (await screen.findByRole('tooltip')).textContent
}

describe('the usage chip', () => {
  it('reads time · in · out · cost, and opens the exact numbers and the agent', async () => {
    stubFetch()
    renderUsage(run('done', { runner: 'codex', model: 'gpt-5.2-codex', startedAt: '2026-07-14T12:00:00.000Z', finishedAt: '2026-07-14T12:06:13.000Z', costUsd: 0.83 }))
    const chip = screen.getByRole('button', { name: 'Agent: codex, model gpt-5.2-codex' })
    expect(chip.getAttribute('data-slot')).toBe('agent-badge')
    expect(chip.querySelector('[data-slot="usage-summary"]')?.textContent).toBe('6m 13s · 24.6k in · 2.4k out · $0.83')
    fireEvent.click(chip)
    const details = within(await screen.findByRole('dialog'))
    expect(details.getByText('Duration').nextElementSibling?.textContent).toBe('6m 13s')
    expect(details.getByText('Input tokens').nextElementSibling?.textContent).toBe('24,600')
    expect(details.getByText('Output tokens').nextElementSibling?.textContent).toBe('2,400')
    expect(details.getByText('Cost').nextElementSibling?.textContent).toBe('$0.83')
    expect(details.getByText('Runner').nextElementSibling?.textContent).toBe('codex')
    expect(details.getByText('Model').nextElementSibling?.textContent).toBe('gpt-5.2-codex')
  })

  it('says only what the record carries', () => {
    stubFetch()
    renderUsage(run('done', { inputTokens: undefined, outputTokens: undefined }))
    expect(document.querySelector('[data-slot="usage-summary"]')?.textContent).toBe('claude · auto')
  })

  it('carries the runner and model as the chip, never as loose text beside it', () => {
    stubFetch()
    renderUsage(run('done', { runner: 'codex', model: 'gpt-5.2-codex', costUsd: 0.04 }))
    const badge = within(usage()).getByRole('button', { name: /Agent: codex, model gpt-5.2-codex/ })
    expect(badge.querySelector('[data-slot="usage-summary"]')?.textContent).toBe('24.6k in · 2.4k out · $0.04')
    // Not loose text: nothing runner/model-shaped outside the badge's accessible name.
    expect(usage().textContent).not.toContain('codex')
  })

  it('narrows to the cost on a phone', () => {
    stubFetch()
    renderUsage(run('review', { costUsd: 0.04 }))
    expect(usage().querySelector('[data-slot="agent-badge"] .md\\:hidden')?.textContent).toBe('$0.04')
  })

  it('omits token and cost text when health disables token metrics', async () => {
    stubFetch({
      '/api/v1/health': () =>
        jsonResponse({
          capabilities: {
            localHandoff: true,
            terminal: false,
            followups: false,
            singleProject: false,
            tokenMetrics: false,
          },
        }),
    })
    renderUsage(run('done', { costUsd: 0.04 }))

    await waitFor(() => {
      expect(usage().textContent).not.toContain('24.6k')
      expect(usage().textContent).not.toContain('$0.04')
    })
    expect(within(usage()).getByRole('button', { name: /Agent:/ })).not.toBeNull()
  })

  it('reveals runner and model on click, reading "auto" when the model is unset', async () => {
    stubFetch()
    renderUsage(run('done', { runner: 'opencode' }))
    const details = within(await openDetails())
    expect(details.getByText('Runner').nextElementSibling?.textContent).toBe('opencode')
    expect(details.getByText('Model').nextElementSibling?.textContent).toBe('auto')
  })

  it('offers the next-continuation engine picker inside the existing agent badge', async () => {
    stubFetch()
    renderUsage(run('done', { runner: 'claude', model: 'sonnet' }), <button type="button" aria-label="Model">sonnet</button>)
    const details = await openDetails()
    expect(within(details).getByText('Next continuation')).not.toBeNull()
    expect(details.querySelector('[data-slot="agent-badge-engine-picker"]')).not.toBeNull()
    expect(within(details).getByRole('button', { name: 'Model' }).textContent).toBe('sonnet')
  })

  it('keeps the historical badge read-only when no continuation picker is owned by the view', async () => {
    stubFetch()
    renderUsage(run('running', { runner: 'claude', model: 'sonnet' }))
    const details = await openDetails()
    expect(within(details).queryByText('Next continuation')).toBeNull()
  })

  // #416: the record persists only the runner the caller ASKED for (`src/runs/store.ts`), while
  // the run executes as `input.runner ?? config.defaultRunner` (`src/workflows/run.ts`). So a
  // record without a runner must name the repo's DEFAULT agent — hardcoding 'claude' here would
  // confidently name the wrong agent on a codex/opencode repo, which is the exact question the
  // badge exists to answer.
  it('a run with no explicit runner names the active project config default, not boot health', async () => {
    stubFetch({
      '/api/v1/health': () => jsonResponse({ defaultRunner: 'claude' }),
      '/api/v1/config': () => jsonResponse({ defaultRunner: 'codex', defaultModels: {} }),
    })
    renderUsage(run('done', { runner: undefined }))
    const badge = await within(usage()).findByRole('button', { name: /Agent: codex, model auto/ })
    expect(badge.getAttribute('data-slot')).toBe('agent-badge')
  })

  it('a claude run still gets an agent badge — Claude is the default, not a hidden runner', () => {
    stubFetch()
    renderUsage(run('done', { runner: 'claude' }))
    const badge = within(usage()).getByRole('button', { name: /Agent: claude, model auto/ })
    // Named like any other agent — claude being the default is not a reason to leave "what
    // produced this?" unanswered.
    expect(badge.getAttribute('aria-label')).toBe('Agent: claude, model auto')
  })

  it('explains itself in one line on hover, and opens the sheet on click', async () => {
    stubFetch()
    renderUsage(run('running', { runner: 'claude', model: 'opus' }))
    const badge = within(usage()).getByRole('button', { name: /Agent: claude, model opus/ })
    expect(await tooltipOf(badge)).toBe('Time, tokens, cost and the agent — click for details')
    fireEvent.blur(badge)
  })

  /**
   * Which ACCOUNT a task ran under (spec 2026-07-29-agent-profiles). Read from the step that
   * actually spawned, never from the run's composer override or the project's current selection:
   * the override is absent whenever the run simply followed the project, and the selection can have
   * changed since — either would name an account this run may never have touched.
   */
  describe('the account a task ran under', () => {
    const withAccounts = (extra: Record<string, () => Response> = {}) => stubFetch({
      '/api/v1/workspace/agent-profiles': () => jsonResponse({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [
          { id: 'default', provider: 'claude', label: 'Default', configDir: '~/.claude', path: '/home/u/.claude', exists: true, looksValid: true, isDefault: true, files: [] },
          { id: 'klaudiusz', provider: 'claude', label: 'Klaudiusz', configDir: '~/.claude-klaudiusz', path: '/home/u/.claude-klaudiusz', exists: true, looksValid: true, isDefault: false, files: [] },
        ],
      }),
      ...extra,
    })

    it('names the account the step recorded, by its label — visibly, not only on click', async () => {
      withAccounts()
      renderUsage(run('done', {
        runner: 'claude',
        model: 'opus',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      const badge = await within(usage()).findByRole('button', { name: /Agent: claude, account Klaudiusz, model opus/ })
      // The chip's accessible name carries it; the popover labels it.
      fireEvent.click(badge)
      expect((await screen.findByRole('dialog')).querySelector('[data-slot="agent-badge-account"]')?.textContent).toBe('Klaudiusz')
    })

    it('prefers what RAN over what the composer asked for', async () => {
      // A resumed run reattaches to the account that owns the session, whatever the run record's
      // override says — so the badge must report the step, or it would name the wrong subscription.
      withAccounts()
      renderUsage(run('done', {
        runner: 'claude',
        agentProfile: 'default',
        steps: [step({ sessionId: 'sess-1', profileId: 'klaudiusz' })],
      }))
      await within(usage()).findByRole('button', { name: /account Klaudiusz/ })
    })

    it('says nothing at all for a run from before accounts existed', async () => {
      // Nothing wrote it down, so claiming the discovered account would be an invention.
      withAccounts()
      renderUsage(run('done', { runner: 'claude', steps: [step({ sessionId: 'sess-1' })] }))
      await within(usage()).findByRole('button', { name: /Agent: claude, model auto/ })
      expect(usage().querySelector('[data-slot="agent-badge-account"]')).toBeNull()
    })

    it('still names an account that has since been removed', async () => {
      // The id is the only remaining pointer to the folder this run's sessions live in.
      withAccounts()
      renderUsage(run('done', {
        runner: 'claude',
        steps: [step({ sessionId: 'sess-1', profileId: 'deleted-one' })],
      }))
      await within(usage()).findByRole('button', { name: /account deleted-one \(removed\)/ })
    })
  })

  describe('the canonical model identity (#546)', () => {
    it('shows the provider/model the run actually resolved to', async () => {
      // The reader `modelIdentity` was missing (#546): #405 persisted it for cost attribution and
      // replay and nothing read it, so the field could rot without anyone noticing.
      stubFetch()
      renderUsage(run('done', {
        runner: 'claude',
        model: 'opus',
        modelIdentity: 'anthropic/claude-opus-4-8',
      }))
      const menu = await openDetails()
      expect(menu.querySelector('[data-slot="agent-badge-identity"]')?.textContent)
        .toBe('anthropic/claude-opus-4-8')
      // It ADDS to the asked-for model rather than replacing it — `model` is still the free-text
      // the caller typed, and losing that would make the badge answer a different question.
      expect(within(menu).getByText('Model').nextElementSibling?.textContent).toBe('opus')
    })

    it('says nothing for a run from before the identity was recorded', async () => {
      // Same omitted-not-guessed rule as the account line: resolving it now would attribute a
      // provider to a run that never wrote one down.
      stubFetch()
      renderUsage(run('done', { runner: 'claude', model: 'opus' }))
      const menu = await openDetails()
      expect(menu.querySelector('[data-slot="agent-badge-identity"]')).toBeNull()
    })

    it('omits the line when it would only repeat the model', async () => {
      // A gateway id is already in provider/model form, so echoing it would be noise in a menu
      // whose whole value is that every line answers something.
      stubFetch()
      renderUsage(run('done', {
        runner: 'claude',
        model: 'anthropic/claude-opus-4-8',
        modelIdentity: 'anthropic/claude-opus-4-8',
      }))
      const menu = await openDetails()
      expect(menu.querySelector('[data-slot="agent-badge-identity"]')).toBeNull()
      expect(within(menu).getByText('Model').nextElementSibling?.textContent).toBe('anthropic/claude-opus-4-8')
    })
  })
})

describe('the live gauges', () => {
  const liveUsage = () => ({
    at: new Date().toISOString(),
    contextTokens: 41_600,
    contextWindow: 200_000,
    limits: [{ window: 'five_hour', utilization: 0.19, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }],
  })

  it('sit before the chip, on the same line, while the preference is on', () => {
    stubFetch()
    renderUsage(run('running', { liveUsage: liveUsage() }))
    const gauges = usage().querySelector('[data-slot="live-usage"]') as HTMLElement
    expect(gauges.textContent).toContain('5h 81% left')
    expect(gauges.textContent).toContain('CTX 41.6k 21%')
    const badge = usage().querySelector('[data-slot="agent-badge"]') as HTMLElement
    expect(gauges.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stay away once switched off in Settings, leaving the chip alone', () => {
    localStorage.setItem(LIVE_USAGE_STORAGE_KEY, 'off')
    stubFetch()
    renderUsage(run('running', { liveUsage: liveUsage() }))
    expect(usage().querySelector('[data-slot="live-usage"]')).toBeNull()
    expect(usage().querySelector('[data-slot="agent-badge"]')).not.toBeNull()
  })

  it('are absent, not blank, for a run that never reported any', () => {
    stubFetch()
    renderUsage(run('running'))
    expect(usage().querySelector('[data-slot="live-usage"]')).toBeNull()
  })
})

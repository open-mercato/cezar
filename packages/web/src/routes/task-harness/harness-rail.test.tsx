import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'

import { HarnessRail } from './harness-rail'

/**
 * Fidelity to mockup 01 (user feedback 2026-07-27: "in PHASE tile, there were
 * lines connecting phases, they are not in your real implementation").
 *
 * The connector is what makes the tile a timeline rather than five unrelated
 * rows, so it is pinned here: drawn behind the dots, clipped at the first and
 * last row so it never dangles, and masked by a card-coloured ring on each dot.
 */
const phase = (id: string, over: Partial<HarnessLedgerResponse['phases'][number]> = {}) =>
  ({
    id,
    name: id,
    kind: 'agent' as const,
    status: 'done' as const,
    attempts: 1,
    artifacts: {},
    startedAt: '2026-07-27T10:00:00.000Z',
    endedAt: '2026-07-27T10:05:00.000Z',
    ...over,
  }) as HarnessLedgerResponse['phases'][number]

const ledger = (over: Partial<HarnessLedgerResponse> = {}): HarnessLedgerResponse =>
  ({
    version: 2,
    workflow: 'harness-fix-issue',
    phases: [phase('preflight'), phase('spec'), phase('stage')],
    councils: [],
    models: [],
    invocations: [],
    packets: [],
    validation: [],
    decisions: [],
    pendingMessages: [],
    loops: { fixRounds: 0, maxFixRounds: 3 },
    outcome: { status: 'ready', blockingReasons: [] },
    stage: { status: 'staged' },
    roles: null,
    ...over,
  }) as unknown as HarnessLedgerResponse

const lines = () =>
  [...document.querySelectorAll('[data-slot="harness-rail"] ol li span[aria-hidden="true"]')]

afterEach(cleanup)

describe('HarnessRail phase tile', () => {
  it('draws a connector on every step, clipped at the ends', () => {
    render(<HarnessRail ledger={ledger()} />)

    const drawn = lines()
    expect(drawn).toHaveLength(3)
    expect(drawn[0]!.className).toContain('top-1/2')
    expect(drawn[0]!.className).not.toContain('bottom-1/2')
    expect(drawn[1]!.className).toContain('-top-3.5')
    expect(drawn[1]!.className).toContain('-bottom-3.5')
    expect(drawn[2]!.className).toContain('bottom-1/2')
  })

  it('masks the line behind each status dot', () => {
    render(<HarnessRail ledger={ledger()} />)

    const dot = document.querySelector('[data-slot="harness-rail"] ol li [data-slot="status-dot"]')!
    expect(dot.className).toContain('shadow-[0_0_0_3px_var(--card)]')
    expect(dot.className).toContain('z-[1]')
  })

  it('is a single dot with no dangling line when only one phase ran', () => {
    render(<HarnessRail ledger={ledger({ phases: [phase('preflight')] })} />)

    const only = lines()[0]!
    expect(only.className).toContain('top-1/2')
    expect(only.className).toContain('bottom-1/2')
  })

  it('shows each phase duration and the retry count inline', () => {
    render(
      <HarnessRail
        ledger={ledger({
          phases: [
            phase('spec', { attempts: 3 }),
            phase('stage', { endedAt: '2026-07-27T10:00:02.000Z' }),
          ],
        })}
      />,
    )

    expect(screen.getByText('3×')).not.toBeNull()
    expect(screen.getByText('5m')).not.toBeNull()
    expect(screen.getByText('2s')).not.toBeNull()
  })

  it('offers the full timeline when a handler is wired', () => {
    render(<HarnessRail ledger={ledger()} onOpenTimeline={() => {}} />)

    expect(screen.getByText(/Full timeline · 3 phases/)).not.toBeNull()
  })

  it('names the roles the roster covers', () => {
    render(
      <HarnessRail
        ledger={ledger({
          models: [
            { id: 'claude/sonnet', roles: ['orchestrator'], readiness: 'ready', invocations: 0, totalDurationMs: 0 },
            { id: 'codex/gpt', roles: ['implementer', 'reviewer'], readiness: 'ready', invocations: 0, totalDurationMs: 0 },
          ] as HarnessLedgerResponse['models'],
        })}
      />,
    )

    for (const role of ['orchestrator', 'implementer', 'reviewer']) {
      expect(screen.getByText(role)).not.toBeNull()
    }
  })
})

/**
 * Reading what a reviewer was actually asked used to mean leaving the tab you
 * were watching the run in, opening Review, and scrolling past the findings to
 * the council table at the bottom — while the same reviewers were listed in the
 * rail the whole time (user feedback 2026-07-27).
 */
describe('HarnessRail council tile', () => {
  const withCouncil = () =>
    ledger({
      councils: [
        {
          round: 1,
          kind: 'implementation',
          verdict: 'request_changes',
          reviewers: [
            { id: 'codex/gpt-5.6-luna', status: 'completed', findings: [{ severity: 'major' }] },
            { id: 'opencode/deepseek/deepseek-v4-flash', status: 'completed', findings: [] },
          ],
        },
      ],
      models: [{ id: 'codex/gpt-5.6-luna', family: 'openai' }],
    } as unknown as Partial<HarnessLedgerResponse>)

  it('opens the reviewer drill-down straight from the rail', async () => {
    const opened: string[] = []
    render(<HarnessRail ledger={withCouncil()} onOpenReviewer={(id) => opened.push(id)} />)
    const rows = screen.getAllByRole('button', { name: /gpt-5\.6-luna|deepseek-v4-flash/ })
    expect(rows).toHaveLength(2)
    rows[0]!.click()
    expect(opened).toEqual(['codex/gpt-5.6-luna'])
  })

  it('stays inert where no handler is wired, rather than rendering dead buttons', () => {
    render(<HarnessRail ledger={withCouncil()} />)
    expect(
      document.querySelectorAll('[data-slot="harness-rail-reviewer"]'),
    ).toHaveLength(0)
    expect(screen.getAllByText('gpt-5.6-luna').length).toBeGreaterThan(0)
  })
})

/**
 * Council resilience (2026-07-29): a council paused below quorum surfaces its
 * two exits — retry the failed reviewers, or proceed with the survivors —
 * right under the reviewer rows. Proceed only exists when someone survived,
 * and the card never renders without a runId to act on.
 */
describe('HarnessRail council decision card', () => {
  const council = (reviewers: Array<Record<string, unknown>>) =>
    [{ round: 1, kind: 'implementation', reviewers, verdict: null }] as unknown as
      HarnessLedgerResponse['councils']
  const paused = (over: Partial<HarnessLedgerResponse['outcome']['pendingDecision']> = {}) =>
    ledger({
      councils: council([
        { id: 'claude/opus', status: 'completed', verdict: 'approve', findings: [] },
        { id: 'cez-codex-gpt', status: 'failed', reason: 'transport died' },
      ]),
      outcome: {
        status: 'blocked',
        blockingReasons: ['implementation council did not reach quorum'],
        pendingDecision: {
          kind: 'council',
          council: 'implementation',
          round: 1,
          failed: [{ label: 'cez-codex-gpt', reason: 'transport died' }],
          completedCount: 1,
          canProceed: true,
          ...over,
        },
      } as HarnessLedgerResponse['outcome'],
    })
  const renderRail = (l: HarnessLedgerResponse, runId?: string) =>
    render(
      <QueryClientProvider client={createQueryClient()}>
        <HarnessRail ledger={l} runId={runId} />
      </QueryClientProvider>,
    )

  it('offers retry and proceed when survivors exist', () => {
    renderRail(paused(), 'r1')

    expect(document.querySelector('[data-slot="council-decision"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="council-retry"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="council-proceed"]')).not.toBeNull()
    expect(screen.getByText(/produced no review/).textContent).toContain('1 review completed')
  })

  it('offers only retry when every reviewer failed', () => {
    renderRail(paused({ completedCount: 0, canProceed: false }), 'r1')

    expect(document.querySelector('[data-slot="council-retry"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="council-proceed"]')).toBeNull()
  })

  it('stays read-only without a runId to act on', () => {
    renderRail(paused())

    expect(document.querySelector('[data-slot="council-decision"]')).toBeNull()
  })
})

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'

import { HarnessTimeline } from './harness-status-bar'

const phase = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    kind: 'agent',
    status: 'done',
    attempts: 1,
    artifacts: {},
    startedAt: '2026-07-27T10:00:00.000Z',
    endedAt: '2026-07-27T10:01:00.000Z',
    ...over,
  }) as HarnessLedgerResponse['phases'][number]

const ledger = (over: Partial<HarnessLedgerResponse> = {}): HarnessLedgerResponse =>
  ({
    version: 2,
    workflow: 'harness-fix-issue',
    phases: [phase('preflight'), phase('review')],
    councils: [
      {
        round: 1,
        kind: 'implementation',
        verdict: 'request_changes',
        reviewers: [
          { id: 'codex/gpt', status: 'completed', verdict: 'request_changes', findings: [{ severity: 'major', title: 'x' }] },
          { id: 'opencode/mimo', status: 'completed', verdict: 'approve', findings: [] },
        ],
      },
    ],
    models: [
      { id: 'codex/gpt', model: 'gpt', family: 'openai', roles: ['reviewer'], readiness: 'ready', invocations: 1, totalDurationMs: 9_000_000 },
      { id: 'opencode/mimo', model: 'mimo', family: 'xiaomi', roles: ['reviewer'], readiness: 'ready', invocations: 1, totalDurationMs: 9_000_000 },
    ],
    invocations: [
      { id: 'i1', phaseId: 'review', role: 'reviewer', reviewerId: 'codex/gpt', binding: { runner: 'codex' }, status: 'completed', attempt: 1, inputSha256: 'x', durationMs: 62_000 },
    ],
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

afterEach(cleanup)

describe('HarnessTimeline', () => {
  it('leads with the run totals', () => {
    render(<HarnessTimeline ledger={ledger()} />)
    for (const label of ['Wall clock', 'Model time', 'Retries', 'Reviewers']) {
      expect(screen.getByText(label)).not.toBeNull()
    }
  })

  it('expands a council phase into its reviewers', () => {
    render(<HarnessTimeline ledger={ledger()} />)
    expect(screen.getByText('gpt')).not.toBeNull()
    expect(screen.getByText('1 major')).not.toBeNull()
  })

  it('never attaches a council to a phase that is not one', () => {
    render(<HarnessTimeline ledger={ledger({ phases: [phase('preflight')] })} />)
    expect(screen.queryByText('gpt')).toBeNull()
  })

  it("shows a reviewer's time in THIS phase, not its whole-run total", () => {
    render(<HarnessTimeline ledger={ledger()} />)
    expect(screen.getByText('1m 2s')).not.toBeNull()
    expect(screen.queryByText('150m')).toBeNull()
  })

  it('counts retries across the run', () => {
    render(<HarnessTimeline ledger={ledger({ phases: [phase('spec', { attempts: 3 }), phase('stage')] })} />)
    const retries = screen.getByText('Retries').closest('div')!
    expect(within(retries).getByText('2')).not.toBeNull()
  })
})

/**
 * The wall-clock graph (user request 2026-07-29): one shared time axis, one
 * bar per phase positioned by its real start/end — reading WHERE the run's
 * hours went, not just each phase's own duration. Needs two dated phases;
 * anything less has no axis to draw.
 */
describe('WallClockGraph', () => {
  it('draws one positioned bar per dated phase over a shared axis', async () => {
    const { WallClockGraph } = await import('./harness-status-bar')
    render(
      <WallClockGraph
        phases={[
          phase('spec', {
            startedAt: '2026-07-29T10:00:00.000Z',
            endedAt: '2026-07-29T10:10:00.000Z',
          }),
          phase('implement', {
            startedAt: '2026-07-29T10:10:00.000Z',
            endedAt: '2026-07-29T10:40:00.000Z',
          }),
        ]}
      />,
    )

    const graph = document.querySelector('[data-slot="wall-clock-graph"]')!
    expect(graph).not.toBeNull()
    const bars = graph.querySelectorAll('i[title]')
    expect(bars).toHaveLength(2)
    // The second phase starts a quarter into the 40-minute span.
    expect((bars[1] as HTMLElement).style.left).toBe('25%')
    expect((bars[1] as HTMLElement).style.width).toBe('75%')
    // The axis is labeled from +0s to the full span.
    expect(graph.textContent).toContain('+0s')
    expect(graph.textContent).toContain('+40m')
  })

  it('renders nothing for a run without two dated phases', async () => {
    const { WallClockGraph } = await import('./harness-status-bar')
    render(<WallClockGraph phases={[phase('spec', { startedAt: undefined, endedAt: undefined })]} />)
    expect(document.querySelector('[data-slot="wall-clock-graph"]')).toBeNull()
  })
})

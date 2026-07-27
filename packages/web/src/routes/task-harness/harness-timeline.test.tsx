import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'

import { HarnessTimeline } from './harness-status-bar'

/** Fidelity to mockup 04, and two bugs the first cut of it had. */
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
    // Regression: matching on round alone defaulted every unlabelled phase to
    // round 1, so Preflight and Capture sprouted the whole council.
    render(<HarnessTimeline ledger={ledger({ phases: [phase('preflight')] })} />)
    expect(screen.queryByText('gpt')).toBeNull()
  })

  it("shows a reviewer's time in THIS phase, not its whole-run total", () => {
    render(<HarnessTimeline ledger={ledger()} />)
    // 62s here; the model's run total is 9,000,000ms (2h 30m) and must not leak in.
    expect(screen.getByText('1m 2s')).not.toBeNull()
    expect(screen.queryByText('150m')).toBeNull()
  })

  it('counts retries across the run', () => {
    render(<HarnessTimeline ledger={ledger({ phases: [phase('spec', { attempts: 3 }), phase('stage')] })} />)
    const retries = screen.getByText('Retries').closest('div')!
    expect(within(retries).getByText('2')).not.toBeNull()
  })
})

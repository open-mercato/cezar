import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'

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
    // First: starts at its own dot, so nothing dangles above the tile.
    expect(drawn[0]!.className).toContain('top-1/2')
    expect(drawn[0]!.className).not.toContain('bottom-1/2')
    // Middle: overhangs both ways so consecutive segments join.
    expect(drawn[1]!.className).toContain('-top-3.5')
    expect(drawn[1]!.className).toContain('-bottom-3.5')
    // Last: stops at its own dot.
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

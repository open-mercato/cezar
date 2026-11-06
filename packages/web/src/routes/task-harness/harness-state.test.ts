import { describe, expect, it } from 'vitest'

import type { HarnessLedgerResponse, RunEvent } from '@open-mercato/cezar-api-client'

import { holdGitSteps } from '../task-git/run-git-step'
import {
  activeHarnessPhase,
  currentImplementationCouncil,
  foldHarnessSnapshot,
  harnessPublishBlockedReason,
  harnessWindowGap,
  mergeHarnessLedger,
} from './harness-state'

function ledger(): HarnessLedgerResponse {
  return {
    version: 2,
    workflow: 'cez-harness-fix-issue',
    requestedProfile: 'multi',
    effectiveProfile: 'multi',
    phases: [
      {
        id: 'implement',
        name: 'Implement',
        kind: 'op',
        status: 'running',
        attempts: 1,
        artifacts: {},
      },
    ],
    models: [
      {
        id: 'claude',
        family: 'anthropic',
        roles: ['host', 'reviewer'],
        readiness: 'ready',
        invocations: 1,
        totalDurationMs: 1_000,
      },
    ],
    councils: [
      {
        round: 1,
        kind: 'implementation',
        reviewers: [{ id: 'claude', status: 'running' }],
      },
    ],
    invocations: [
      {
        id: 'review-1-claude',
        phaseId: 'review',
        role: 'reviewer',
        reviewerId: 'claude',
        binding: { runner: 'claude', model: 'sonnet' },
        status: 'running',
        attempt: 1,
        inputSha256: 'input-one',
      },
    ],
    pendingMessages: [
      {
        id: 'message-1',
        text: 'Keep the alias.',
        createdAt: '2026-07-26T10:00:00.000Z',
      },
    ],
    stage: { status: 'pending' },
    outcome: { status: 'pending', blockingReasons: [] },
  }
}

function event(seq: number, type: string, payload: Record<string, unknown>): RunEvent {
  return {
    seq,
    ts: `2026-07-26T10:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    ...payload,
  }
}

describe('mergeHarnessLedger', () => {
  it('keeps setup, validation, findings and the next-action revision current through replay', () => {
    const snapshot = { ...ledger(), snapshotSeq: 10, actionRevision: 'old' }
    const environment = { status: 'ready', detail: 'Dependencies installed.' }
    const checks = [{ command: 'npm test', status: 'passed', exitCode: 0, evidence: 'passed' }]
    const findings = [{ id: 'finding-a', kind: 'implementation', title: 'Scope check', severity: 'major', reviewers: ['claude'], firstRound: 1, lastRound: 4, status: 'resolved' }]
    const action = { id: 'action-a', action: 'verify', status: 'completed', round: 4, findingIds: [], requestedAt: '', subjectSha256: 'sha' }
    const updates = [
      event(9, 'harness.environment.updated', { environment: { status: 'needs-setup' } }),
      event(11, 'harness.environment.updated', { environment }),
      event(12, 'harness.validation.updated', { checks }),
      event(13, 'harness.findings.updated', { findings }),
      event(14, 'harness.review-action.updated', { action, actionRevision: 'current' }),
    ]
    const folded = foldHarnessSnapshot(snapshot, updates)!
    expect(folded).toMatchObject({ environment, validation: checks, findingHistory: findings, reviewAction: action, actionRevision: 'current', snapshotSeq: 14 })
    expect(mergeHarnessLedger(folded, updates)).toEqual(folded)
    expect(snapshot.actionRevision).toBe('old')
  })

  it('replaces an old round 3 with feedback round 1 before the refreshed snapshot arrives', () => {
    const snapshot = ledger()
    snapshot.councils = [
      { round: 1, kind: 'spec', reviewers: [] },
      { round: 3, kind: 'implementation', reviewers: [], verdict: 'approve' },
    ]
    snapshot.stage = { status: 'staged' }
    snapshot.outcome = { status: 'ready', blockingReasons: [] }
    const reset = event(10, 'harness.feedback.applied', {
      phaseId: 'implement', messageIds: ['message-1'],
    })
    const restarted = mergeHarnessLedger(snapshot, [reset])!
    expect(restarted.stage.status).toBe('pending')
    expect(restarted.outcome.status).toBe('pending')
    expect(restarted.councils).toEqual([{ round: 1, kind: 'spec', reviewers: [] }])

    const merged = mergeHarnessLedger(snapshot, [reset, event(11, 'harness.council.updated', {
      council: { round: 1, kind: 'implementation', reviewers: [], verdict: 'request_changes' },
    })])!
    expect(currentImplementationCouncil(merged)).toMatchObject({
      round: 1, verdict: 'request_changes',
    })
    expect(snapshot.councils[1]?.round).toBe(3)
    expect(snapshot.stage.status).toBe('staged')
  })

  it('reconstructs every live harness entity over a durable snapshot without mutating it', () => {
    const snapshot = ledger()
    const events = [
      event(1, 'harness.phase.updated', {
        phase: {
          ...snapshot.phases[0],
          status: 'done',
          endedAt: '2026-07-26T10:00:01.000Z',
        },
      }),
      event(2, 'harness.readiness.updated', {
        profile: 'multi',
        models: [
          {
            ...snapshot.models[0],
            invocations: 2,
            totalDurationMs: 3_000,
          },
          {
            id: 'codex',
            family: 'openai',
            roles: ['implementer', 'reviewer'],
            readiness: 'ready',
            invocations: 1,
            totalDurationMs: 2_000,
          },
        ],
      }),
      event(3, 'harness.council.updated', {
        council: {
          round: 1,
          kind: 'implementation',
          reviewers: [{ id: 'claude', status: 'completed', verdict: 'approve' }],
          verdict: 'approve',
          findings: [],
        },
      }),
      event(5, 'harness.invocation.updated', {
        invocation: {
          ...snapshot.invocations[0],
          status: 'completed',
          artifactPath: 'artifacts/review-1-claude.json',
          artifactSha256: 'artifact-one',
        },
      }),
      event(6, 'harness.stage.updated', {
        stage: { status: 'staged', stagedPaths: ['src/one.ts'] },
      }),
      event(7, 'harness.outcome.updated', {
        outcome: {
          status: 'contested',
          blockingReasons: ['[major] compatibility risk remains'],
        },
      }),
      event(8, 'harness.message.consumed', { messageIds: ['message-1'] }),
    ]

    const merged = mergeHarnessLedger(snapshot, events)

    expect(merged).toMatchObject({
      phases: [{ id: 'implement', status: 'done' }],
      models: [
        { id: 'claude', invocations: 2 },
        { id: 'codex', invocations: 1 },
      ],
      councils: [{ round: 1, kind: 'implementation', verdict: 'approve' }],
      invocations: [{ id: 'review-1-claude', status: 'completed' }],
      stage: { status: 'staged', stagedPaths: ['src/one.ts'] },
      outcome: {
        status: 'contested',
        blockingReasons: ['[major] compatibility risk remains'],
      },
      pendingMessages: [
        {
          id: 'message-1',
          consumedAt: '2026-07-26T10:00:08.000Z',
        },
      ],
    })
    expect(snapshot).toMatchObject({
      phases: [{ status: 'running' }],
      invocations: [{ status: 'running' }],
      stage: { status: 'pending' },
      outcome: { status: 'pending' },
      pendingMessages: [{ id: 'message-1' }],
    })
    expect('consumedAt' in snapshot.pendingMessages[0]!).toBe(false)
  })

  it('is idempotent across replay and ignores malformed harness payloads', () => {
    const snapshot = ledger()
    const updates = [
      event(1, 'harness.council.updated', {
        council: { round: 1, kind: 'implementation', verdict: 'approve', findings: [] },
      }),
      event(2, 'harness.phase.updated', { phase: { id: 7, status: 'failed' } }),
      event(3, 'harness.council.updated', { council: { round: 'one', kind: 'implementation' } }),
    ]

    const once = mergeHarnessLedger(snapshot, updates)
    const twice = mergeHarnessLedger(once, updates)

    expect(twice).toEqual(once)
    expect(twice?.councils).toEqual([
      { round: 1, kind: 'implementation', verdict: 'approve', findings: [] },
    ])
    expect(twice?.phases).toEqual(snapshot.phases)
  })

  it('keeps the authoritative snapshot when SSE replays events at or below its watermark', () => {
    const snapshot = {
      ...ledger(),
      snapshotSeq: 42,
      phases: [
        {
          ...ledger().phases[0]!,
          status: 'done' as const,
          endedAt: '2026-07-26T10:10:00.000Z',
        },
      ],
    }
    const merged = mergeHarnessLedger(snapshot, [
      event(41, 'harness.phase.updated', {
        phase: {
          ...snapshot.phases[0],
          status: 'running',
          endedAt: undefined,
        },
      }),
      event(42, 'harness.outcome.updated', {
        outcome: {
          status: 'blocked',
          blockingReasons: ['stale replay'],
        },
      }),
      event(43, 'harness.outcome.updated', {
        outcome: {
          status: 'ready',
          blockingReasons: [],
        },
      }),
    ])

    expect(merged?.phases[0]).toMatchObject({
      id: 'implement',
      status: 'done',
      endedAt: '2026-07-26T10:10:00.000Z',
    })
    expect(merged?.outcome).toEqual({ status: 'ready', blockingReasons: [] })
  })

  it('selects the active phase and newest implementation council', () => {
    const snapshot = ledger()
    snapshot.phases.push({
      id: 'review',
      name: 'Final review',
      kind: 'agent',
      status: 'running',
      attempts: 1,
      artifacts: {},
    })
    snapshot.councils.push(
      { round: 2, kind: 'spec', verdict: 'approve' },
      { round: 3, kind: 'implementation', verdict: 'request_changes' },
      { round: 2, kind: 'implementation', verdict: 'approve' },
    )

    expect(activeHarnessPhase(snapshot)?.id).toBe('review')
    expect(currentImplementationCouncil(snapshot)?.round).toBe(3)
  })

  it('does not invent harness state before the first durable snapshot exists', () => {
    expect(
      mergeHarnessLedger(undefined, [
        event(1, 'harness.phase.updated', {
          phase: {
            id: 'preflight',
            name: 'Preflight',
            kind: 'op',
            status: 'done',
            attempts: 1,
            artifacts: {},
          },
        }),
      ]),
    ).toBeUndefined()
  })
})

// the thread's event window is bounded, so live harness state is folded back into
// the cached snapshot before compaction drops it.
describe('foldHarnessSnapshot', () => {
  const implementDone = event(11, 'harness.phase.updated', {
    phase: { ...ledger().phases[0], status: 'done' },
  })
  const validateRunning = event(12, 'harness.phase.updated', {
    phase: { id: 'validate', name: 'Validate', kind: 'op', status: 'running', attempts: 1, artifacts: {} },
  })

  it('stamps the folded snapshot through the newest harness event, so the window never re-applies', () => {
    const folded = foldHarnessSnapshot({ ...ledger(), snapshotSeq: 10 }, [
      implementDone,
      validateRunning,
      event(13, 'item.completed', {}),
    ])!

    expect(folded.snapshotSeq).toBe(12)
    expect(activeHarnessPhase(folded)?.id).toBe('validate')
    // The events that built it are behind its watermark now: folding again changes nothing.
    expect(foldHarnessSnapshot(folded, [implementDone, validateRunning])).toBeUndefined()
    expect(mergeHarnessLedger(folded, [event(14, 'item.completed', {})])).toEqual(folded)
  })

  it('never moves snapshotSeq backwards over a fresher snapshot', () => {
    expect(foldHarnessSnapshot({ ...ledger(), snapshotSeq: 40 }, [implementDone, validateRunning])).toBeUndefined()
    expect(foldHarnessSnapshot({ ...ledger(), snapshotSeq: 10 }, [event(30, 'item.completed', {})])).toBeUndefined()
    expect(foldHarnessSnapshot(undefined, [validateRunning])).toBeUndefined()
  })
})

describe('harnessWindowGap', () => {
  const window = [event(50, 'item.completed', {}), event(51, 'item.completed', {})]

  it('flags a window that starts past what the snapshot covers while older history is unloaded', () => {
    expect(harnessWindowGap(10, window, true)).toBe(true)
  })

  it('accepts a contiguous window, the whole history, and an empty window', () => {
    expect(harnessWindowGap(49, window, true)).toBe(false)
    expect(harnessWindowGap(60, window, true)).toBe(false)
    expect(harnessWindowGap(10, window, false)).toBe(false)
    expect(harnessWindowGap(10, [], true)).toBe(false)
  })
})

/**
 * Existing runs recorded dynamic steps appended at the tail (fixed at the
 * store for new runs) — the display orders them by the ledger's phases, which
 * were always appended in execution order (user report 2026-07-29).
 */
describe('orderStepsByLedger', () => {
  it('reorders a tail-appended history into execution order, pendings last', async () => {
    const { orderStepsByLedger } = await import('./harness-state')
    const steps = ['preflight', 'capture', 'spec', 'implement', 'validate', 'review', 'stage', 'baseline-gate', 'spec-review', 'fix-2'].map(
      (id) => ({ id }),
    )
    const ledger = {
      phases: ['preflight', 'capture', 'baseline-gate', 'spec', 'spec-review', 'implement', 'validate', 'review', 'fix-2', 'stage'].map(
        (id) => ({ id }),
      ),
    } as never
    expect(orderStepsByLedger(steps, ledger).map((step) => step.id)).toEqual([
      'preflight', 'capture', 'baseline-gate', 'spec', 'spec-review', 'implement', 'validate', 'review', 'fix-2', 'stage',
    ])
  })

  it('keeps not-yet-started steps in stored order after the started ones', async () => {
    const { orderStepsByLedger } = await import('./harness-state')
    const steps = ['preflight', 'spec', 'implement', 'stage'].map((id) => ({ id }))
    const ledger = { phases: [{ id: 'preflight' }, { id: 'baseline-gate' }] } as never
    expect(orderStepsByLedger(steps, ledger).map((step) => step.id)).toEqual([
      'preflight', 'spec', 'implement', 'stage',
    ])
  })

  it('is the identity without a ledger', async () => {
    const { orderStepsByLedger } = await import('./harness-state')
    const steps = [{ id: 'a' }, { id: 'b' }]
    expect(orderStepsByLedger(steps, undefined)).toEqual(steps)
  })
})

describe('harnessPublishBlockedReason — the stage-only hold on git steps', () => {
  const harnessRun = (status: string) => ({ harness: { profile: 'multi' }, status })
  const staged = (outcome: HarnessLedgerResponse['outcome'], extra: Partial<HarnessLedgerResponse> = {}) => ({
    ...ledger(),
    stage: { status: 'staged' },
    outcome,
    ...extra,
  }) as HarnessLedgerResponse

  it('never holds an ordinary run', () => {
    expect(harnessPublishBlockedReason({ status: 'running' }, undefined)).toBeUndefined()
    expect(harnessPublishBlockedReason({ status: 'review' }, undefined)).toBeUndefined()
  })

  // Main's header git steps are prompts to the task's own agent: offered mid-run, Push would be
  // queued for the next harness phase and published a branch the harness still owns.
  it.each(['queued', 'running', 'waiting'])('holds a %s harness run, ledger or not', (status) => {
    expect(harnessPublishBlockedReason(harnessRun(status), staged({ status: 'ready', blockingReasons: [] }))).toMatch(
      /review gate/,
    )
  })

  it('holds a settled run until its ledger is readable and staged', () => {
    expect(harnessPublishBlockedReason(harnessRun('review'), undefined)).toMatch(/unavailable/)
    expect(harnessPublishBlockedReason(harnessRun('review'), ledger())).toMatch(/staged handoff/)
  })

  it('releases a ready outcome, and a contested one only once the user accepted it', () => {
    expect(harnessPublishBlockedReason(harnessRun('review'), staged({ status: 'ready', blockingReasons: [] }))).toBeUndefined()
    const contested = { status: 'contested', blockingReasons: ['risk'] } as HarnessLedgerResponse['outcome']
    expect(harnessPublishBlockedReason(harnessRun('review'), staged(contested))).toMatch(/Accept the unresolved/)
    const at = '2026-07-26T11:00:00.000Z'
    const accepted = staged(
      { ...contested, acceptedAt: at, acceptedBy: 'user', acceptanceReason: 'known risk' } as HarnessLedgerResponse['outcome'],
      { decisions: [{ kind: 'accept-contested', by: 'user', at, detail: 'known risk' }] } as Partial<HarnessLedgerResponse>,
    )
    expect(harnessPublishBlockedReason(harnessRun('done'), accepted)).toBeUndefined()
  })
})

describe('holdGitSteps', () => {
  it('disables the step and every alternative, keeping them visible with the reason', () => {
    const held = holdGitSteps(
      {
        id: 'push',
        label: 'Push',
        enabled: true,
        alternatives: [{ id: 'commit', label: 'Commit', enabled: true }],
      } as Parameters<typeof holdGitSteps>[0],
      'held',
    )
    expect(held).toMatchObject({ id: 'push', enabled: false, reason: 'held' })
    expect(held?.alternatives).toEqual([expect.objectContaining({ id: 'commit', enabled: false, reason: 'held' })])
    expect(holdGitSteps(null, 'held')).toBeNull()
  })
})

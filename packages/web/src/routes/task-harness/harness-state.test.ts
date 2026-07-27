import { describe, expect, it } from 'vitest'

import type { HarnessLedgerResponse, RunEvent } from '@open-mercato/cezar-api-client'

import {
  activeHarnessPhase,
  currentImplementationCouncil,
  mergeHarnessLedger,
} from './harness-state'

function ledger(): HarnessLedgerResponse {
  return {
    version: 2,
    workflow: 'cez-harness-fix-issue',
    requestedProfile: 'high-assurance',
    effectiveProfile: 'high-assurance',
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
    packets: [
      {
        id: 'pk-1',
        originalId: 'pk-1',
        state: 'implementing',
        paths: ['src/one.ts'],
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
        profile: 'high-assurance',
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
      event(4, 'harness.packet.updated', {
        packet: {
          id: 'pk-1-resume-2',
          originalId: 'pk-1',
          effectiveId: 'pk-1-resume-2',
          state: 'gated',
          attempt: 2,
          paths: ['src/one.ts'],
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
      packets: [
        {
          id: 'pk-1-resume-2',
          originalId: 'pk-1',
          state: 'gated',
          attempt: 2,
        },
      ],
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
      packets: [{ id: 'pk-1', state: 'implementing' }],
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
      event(1, 'harness.packet.updated', {
        packet: { id: 'pk-1', originalId: 'pk-1', state: 'gated' },
      }),
      event(2, 'harness.packet.updated', { packet: { state: 'blocked' } }),
      event(3, 'harness.phase.updated', { phase: { id: 7, status: 'failed' } }),
      event(4, 'harness.council.updated', { council: { round: 'one', kind: 'implementation' } }),
    ]

    const once = mergeHarnessLedger(snapshot, updates)
    const twice = mergeHarnessLedger(once, updates)

    expect(twice).toEqual(once)
    expect(twice?.packets).toEqual([
      { id: 'pk-1', originalId: 'pk-1', state: 'gated' },
    ])
    expect(twice?.phases).toEqual(snapshot.phases)
    expect(twice?.councils).toEqual(snapshot.councils)
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

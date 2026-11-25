import type { RunRecord } from '@open-mercato/cezar-api-client'

import type { CardRun } from './cards'

/** Test fixtures for framework cards (spec 2026-11-15-framework-board) — imported by tests only. */
export const FIXTURE_STAGES = ['plan', 'build', 'review']

export function cardRun(over: Partial<RunRecord> = {}, card: Partial<NonNullable<RunRecord['card']>> = {}): CardRun {
  return {
    id: 'c1',
    title: 'Card',
    task: 'Card',
    workflow: 'framework:generic',
    status: 'running',
    createdAt: '2026-11-23T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
    card: {
      framework: 'generic',
      frameworkHash: 'h',
      title: String(over.title ?? 'Card'),
      stage: 'plan',
      stages: { plan: 'running', build: 'pending', review: 'pending' },
      stageOrder: FIXTURE_STAGES,
      ...card,
    },
  } as CardRun
}

export const HUMAN_ASK = {
  requestId: 'q1',
  askedAt: '2026-11-23T10:00:00.000Z',
  questions: [{ header: 'Approval', question: 'Approve?', options: [] }],
}

type CardGate = NonNullable<NonNullable<RunRecord['card']>['gate']>

/** A card parked at `<stage>-gate`; pass `asks: [HUMAN_ASK]` for a gate.human (or `gate` explicitly). */
export function cardAtGate(stage = 'plan', over: Partial<RunRecord> = {}, gate?: CardGate): CardRun {
  const stages: NonNullable<RunRecord['card']>['stages'] = {}
  for (const id of FIXTURE_STAGES) {
    const i = FIXTURE_STAGES.indexOf(id)
    const at = FIXTURE_STAGES.indexOf(stage)
    stages[id] = i < at ? 'done' : i === at ? 'waiting' : 'pending'
  }
  const parked: CardGate = gate ?? (over.asks?.length ? { kind: 'approve' } : { kind: 'framework', approve: stage })
  return cardRun({ status: 'waiting', graphState: { loops: {}, taken: [], cursor: `${stage}-gate` }, ...over }, { stage, stages, gate: parked })
}

/** A card parked in a conversation stage's turn (D10). */
export function cardInConversation(over: Partial<RunRecord> = {}): CardRun {
  return cardRun(
    { status: 'waiting', graphState: { loops: {}, taken: [], cursor: 'plan-agent' }, ...over },
    { stages: { plan: 'waiting', build: 'pending', review: 'pending' }, conversation: true },
  )
}

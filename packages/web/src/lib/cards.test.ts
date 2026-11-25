import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import {
  boardStages,
  cardColumn,
  cardHeadline,
  cardMoves,
  cardNotStarted,
  inConversation,
  wantsRecheck,
  cardStageLabel,
  cardState,
  displayStageStatus,
  dropRule,
  needsYou,
  stripTone,
  isCard,
  openGate,
  reorderPatches,
  stageColumn,
  type CardRun,
} from './cards'
import { cardAtGate, cardInConversation, cardRun, FIXTURE_STAGES, HUMAN_ASK } from './card-fixtures'

const ORDER = FIXTURE_STAGES
const atGate = cardAtGate
const humanAsk = HUMAN_ASK

describe('card columns', () => {
  it('maps run status and held to Backlog / Ready / stage / Ship / Done', () => {
    expect(cardColumn(cardRun({ status: 'queued' }, { held: true }))).toBe('backlog')
    expect(cardColumn(cardRun({ status: 'queued' }))).toBe('ready')
    expect(cardColumn(cardRun({ status: 'running' }, { stage: 'build' }))).toBe('stage:build')
    expect(cardColumn(cardRun({ status: 'failed' }, { stage: 'review' }))).toBe('stage:review')
    expect(cardColumn(cardRun({ status: 'review' }))).toBe('ship')
    expect(cardColumn(cardRun({ status: 'done' }))).toBe('done')
  })

  it('takes stage columns from the active framework, then any stage an older card still has', () => {
    const old = cardRun({}, { stageOrder: ['discover', 'plan', 'build'] })
    expect(boardStages(ORDER, [cardRun(), old])).toEqual(['plan', 'build', 'review', 'discover'])
  })

  it('labels the stage chip with its position among the card’s stages', () => {
    expect(cardStageLabel(cardRun({}, { stage: 'build' }), new Map([['build', 'Build it']]))).toBe('Build it · 2/3')
    expect(cardStageLabel(cardRun({}, { stage: 'review' }))).toBe('Review · 3/3')
  })

  it('tells an ad-hoc run from a card', () => {
    const { card: _card, ...adHoc } = cardRun()
    expect(isCard(adHoc as RunRecord)).toBe(false)
    expect(isCard(cardRun())).toBe(true)
  })
})

describe('gates and state', () => {
  it('reads a gate.human from its open ask, a gate.framework from its absence', () => {
    expect(openGate(atGate('plan', { asks: [humanAsk] }))?.kind).toBe('human')
    expect(openGate(atGate('plan'))?.kind).toBe('framework')
    expect(openGate(cardRun())).toBeUndefined()
    expect(cardState(atGate())).toBe('approve')
    expect(cardState(cardRun({ status: 'failed' }))).toBe('failed')
    expect(cardState(cardInConversation())).toBe('your-turn')
  })

  it('reads the gate from card.gate, not from the cursor', () => {
    // A cursor at `<stage>-gate` with no `card.gate` is not a gate.
    const bare = cardRun({ status: 'waiting', graphState: { loops: {}, taken: [], cursor: 'plan-gate' } })
    expect(openGate(bare)).toBeUndefined()
    expect(openGate(atGate('plan', {}, { kind: 'framework', approve: 'spec' }))).toMatchObject({ kind: 'framework', approve: 'spec' })
    expect(openGate(atGate('plan', {}, { kind: 'approve' }))?.kind).toBe('human')
  })

  it('is a conversation turn only when the engine says so — a question park is a question', () => {
    const atAgent = { status: 'waiting' as const, graphState: { loops: {}, taken: [], cursor: 'plan-agent' } }
    const question = cardRun({ ...atAgent, asks: [humanAsk] })
    expect(inConversation(question)).toBe(false)
    expect(cardState(question)).toBe('question')
    // A terminal agent's interactive tail parks at the agent node too — not a conversation stage.
    expect(inConversation(cardRun(atAgent))).toBe(false)
    expect(inConversation(cardInConversation())).toBe(true)
  })
})

describe('not started (cardNotStarted)', () => {
  const requeued = () =>
    cardRun(
      { status: 'queued', graphState: { loops: {}, taken: [], cursor: 'build-agent' } },
      { stage: 'build', stages: { plan: 'done', build: 'running', review: 'pending' } },
    )

  it('is queued with no cursor; a card re-queued mid-walk has started', () => {
    expect(cardNotStarted(cardRun({ status: 'queued' }))).toBe(true)
    expect(cardNotStarted(requeued())).toBe(false)
    expect(cardNotStarted(cardRun({ status: 'running' }))).toBe(false)
  })

  it('keeps a re-queued card in its stage column, waiting for a slot', () => {
    expect(cardColumn(requeued())).toBe('stage:build')
    expect(cardHeadline(requeued())).toBe('waiting for a slot')
    expect(cardColumn({ ...requeued(), card: { ...requeued().card, held: true } })).toBe('stage:build')
  })

  it('refuses a drag of a re-queued card to the Backlog', () => {
    expect(dropRule(requeued(), 'backlog')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('cannot go back to the backlog') })
    expect(dropRule(requeued(), 'ready')).toMatchObject({ kind: 'refuse' })
  })
})

describe('focus recheck', () => {
  it('runs for a framework gate and a refused precheck, not for a human gate or a WIP park', () => {
    expect(wantsRecheck(atGate('plan'))).toBe(true)
    expect(wantsRecheck(atGate('plan', { asks: [humanAsk] }))).toBe(false)
    const blocked = (reason: 'wip' | 'precheck') => cardRun({ status: 'waiting' }, { blocked: { reason, since: '2026-11-23T10:00:00.000Z' } })
    expect(wantsRecheck(blocked('precheck'))).toBe(true)
    expect(wantsRecheck(blocked('wip'))).toBe(false)
    expect(wantsRecheck(cardRun())).toBe(false)
  })
})

describe('drop rules (D12)', () => {
  it('moves freely between Backlog and Ready, and reorders within Ready', () => {
    expect(dropRule(cardRun({ status: 'queued' }, { held: true }), 'ready')).toEqual({ kind: 'hold', held: false })
    expect(dropRule(cardRun({ status: 'queued' }), 'backlog')).toEqual({ kind: 'hold', held: true })
    expect(dropRule(cardRun({ status: 'queued' }), 'ready')).toEqual({ kind: 'reorder' })
  })

  it('approves only a drop on the stage right after an open gate', () => {
    const gate = atGate('plan', { asks: [humanAsk] })
    expect(dropRule(gate, stageColumn('build'))).toMatchObject({ kind: 'approve', to: 'build', gate: { kind: 'human' } })
    expect(dropRule(gate, stageColumn('review'))).toEqual({
      kind: 'refuse',
      reason: 'Approve moves one stage at a time — move it to Build.',
    })
  })

  it('refuses a forward drag across a gate the framework confirms itself', () => {
    const discover = atGate('plan', {}, { kind: 'framework', approve: null })
    expect(dropRule(discover, stageColumn('build'))).toEqual({
      kind: 'refuse',
      reason: 'This stage is confirmed by the framework’s own `done plan` — there is nothing to approve in cezar.',
    })
    expect(dropRule(atGate('plan'), stageColumn('build'))).toMatchObject({ kind: 'approve', gate: { kind: 'framework' } })
  })

  it('treats a backward drop as Re-run from that stage, only while waiting, failed or at review', () => {
    expect(dropRule(atGate('build'), stageColumn('plan'))).toEqual({ kind: 'rerun', fromStage: 'plan' })
    expect(dropRule(cardRun({ status: 'review' }, { stage: 'review' }), stageColumn('build'))).toEqual({ kind: 'rerun', fromStage: 'build' })
    expect(dropRule(cardRun({ status: 'running' }, { stage: 'build' }), stageColumn('plan'))).toEqual({
      kind: 'refuse',
      reason: 'Re-run from Plan once the card is waiting, failed or at review — it is running now.',
    })
  })

  it('refuses everything else with a reason', () => {
    const running = cardRun({ status: 'running' })
    expect(dropRule(running, stageColumn('build'))).toEqual({
      kind: 'refuse',
      reason: 'A card moves forward only by approving an open gate — this one is not waiting at one.',
    })
    expect(dropRule(cardRun({ status: 'queued' }), stageColumn('plan'))).toEqual({
      kind: 'refuse',
      reason: 'A card enters its first stage when an agent picks it up — move it to Ready.',
    })
    expect(dropRule(running, 'backlog')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('cannot go back to the backlog') })
    expect(dropRule(running, 'done')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('review gate') })
    expect(dropRule(running, stageColumn('discover'))).toEqual({ kind: 'refuse', reason: 'This card’s framework has no Discover stage.' })
    const skipping = atGate('plan')
    skipping.card.stages.build = 'skipped'
    expect(dropRule(skipping, stageColumn('build'))).toEqual({ kind: 'refuse', reason: 'This card skips Build.' })
    expect(dropRule(running, stageColumn('plan'))).toEqual({ kind: 'noop' })
  })
})

describe('phone moves (cardMoves)', () => {
  const NAMES = new Map([['plan', 'Plan'], ['build', 'Build'], ['review', 'Review']])
  const summary = (run: Parameters<typeof cardMoves>[0], ready?: readonly CardRun[]) =>
    cardMoves(run, { names: NAMES, ready }).map((m) => [m.id, m.label, m.reason ?? 'ok'])

  it('offers Backlog ⇄ Ready, and Move up / down by the card’s Ready position', () => {
    expect(summary(cardRun({ status: 'queued' }, { held: true }))).toEqual([['ready', 'Move to Ready', 'ok']])
    const list = ['a', 'b', 'c'].map((id, i) => cardRun({ id, status: 'queued' }, { order: i + 1 }))
    expect(summary(list[0]!, list)).toEqual([
      ['backlog', 'Back to Backlog', 'ok'],
      ['up', 'Move up', 'Already first in Ready — next up.'],
      ['down', 'Move down', 'ok'],
    ])
    expect(summary(list[2]!, list).map((m) => m[2])).toEqual(['ok', 'ok', 'Already last in Ready.'])
  })

  it('hands up / down a drop index the board’s reorder lands one slot over', () => {
    const list = ['a', 'b', 'c'].map((id, i) => cardRun({ id, status: 'queued' }, { order: (i + 1) * 10 }))
    const moves = cardMoves(list[1]!, { ready: list })
    // The board's own rule: a card moving down lands one slot before the tile it is dropped on.
    const land = (readyIndex: number) => (1 < readyIndex ? readyIndex - 1 : readyIndex)
    expect(reorderPatches(list, 'b', land(moves.find((m) => m.id === 'up')!.readyIndex!))).toEqual([{ runId: 'b', order: 10 - 1024 }])
    expect(reorderPatches(list, 'b', land(moves.find((m) => m.id === 'down')!.readyIndex!))).toEqual([{ runId: 'b', order: 30 + 1024 }])
  })

  it('offers Approve across an open gate and Re-run from each earlier stage, by the drop rules', () => {
    const gate = atGate('build', { asks: [humanAsk] })
    const moves = cardMoves(gate, { names: NAMES })
    expect(moves.map((m) => [m.id, m.outcome.kind])).toEqual([
      ['approve', 'approve'],
      ['rerun:plan', 'rerun'],
    ])
    expect(moves[0]!.label).toBe('Approve & continue → Review')
  })

  it('shows a refused move with the reason a refused drop would toast', () => {
    const running = cardRun({ status: 'running' }, { stage: 'build' })
    expect(summary(running)).toEqual([
      ['approve', 'Approve & continue → Review', 'A card moves forward only by approving an open gate — this one is not waiting at one.'],
      ['rerun:plan', 'Re-run from Plan', 'Re-run from Plan once the card is waiting, failed or at review — it is running now.'],
    ])
    const discover = atGate('plan', {}, { kind: 'framework', approve: null })
    expect(cardMoves(discover)[0]!.reason).toContain('confirmed by the framework')
  })

  it('offers a card at review a re-run from any stage and no approve; a finished card nothing it can do', () => {
    expect(summary(cardRun({ status: 'review' }, { stage: 'review' })).map((m) => [m[0], m[2]])).toEqual([
      ['rerun:plan', 'ok'],
      ['rerun:build', 'ok'],
      ['rerun:review', 'ok'],
    ])
    expect(cardMoves(cardRun({ status: 'done' }, { stage: 'review' })).every((m) => m.reason === 'This card has finished — it cannot be moved.')).toBe(true)
    expect(cardMoves(cardRun({ status: 'running' }, { stage: 'plan' })).map((m) => m.id)).toEqual(['approve'])
  })
})

describe('Ready reorder', () => {
  const ready = (id: string, order?: number, createdAt = '2026-11-23T10:00:00.000Z') =>
    cardRun({ id, status: 'queued', createdAt }, order === undefined ? {} : { order })

  it('takes a midpoint between two ordered neighbours — one PATCH', () => {
    const list = [ready('a', 1024), ready('b', 2048), ready('c', 3072)]
    expect(reorderPatches(list, 'c', 1)).toEqual([{ runId: 'c', order: 1536 }])
    expect(reorderPatches(list, 'c', 0)).toEqual([{ runId: 'c', order: 0 }])
    expect(reorderPatches(list, 'a', 3)).toEqual([{ runId: 'a', order: 3072 + 1024 }])
  })

  it('renumbers the list when the neighbours have no order yet', () => {
    const list = [ready('a'), ready('b'), ready('c')]
    expect(reorderPatches(list, 'c', 0)).toEqual([
      { runId: 'c', order: 1024 },
      { runId: 'a', order: 2048 },
      { runId: 'b', order: 3072 },
    ])
  })

  it('sends nothing when the card lands where it was', () => {
    expect(reorderPatches([ready('a', 1), ready('b', 2)], 'b', 1)).toEqual([])
  })
})

describe('a card closed on an unanswered question', () => {
  const AT = '2026-11-23T11:00:00.000Z'
  const asked = cardRun({ status: 'failed', awaitingAnswerSince: AT }, { stage: 'build', stages: { plan: 'done', build: 'failed', review: 'pending' } })
  const failed = cardRun({ status: 'failed' }, { stage: 'build', stages: { plan: 'done', build: 'failed', review: 'pending' } })

  it('shows its stage as waiting for you, not failed', () => {
    expect(displayStageStatus(asked, 'build')).toBe('waiting')
    expect(displayStageStatus(asked, 'plan')).toBe('done')
    expect(displayStageStatus(asked, 'review')).toBe('pending')
    expect(stripTone(displayStageStatus(asked, 'build'))).toBe('waiting')
  })

  it('reads as a question that needs you on the board and the list', () => {
    expect(cardState(asked)).toBe('question')
    expect(needsYou(asked)).toBe(true)
    expect(cardHeadline(asked)).toBe('❓ a question for you')
    // Re-run stays available.
    expect(dropRule(asked, stageColumn('plan'))).toEqual({ kind: 'rerun', fromStage: 'plan' })
  })

  it('leaves a plain failure a failure', () => {
    expect(displayStageStatus(failed, 'build')).toBe('failed')
    expect(cardState(failed)).toBe('failed')
    expect(needsYou(failed)).toBe(false)
  })
})

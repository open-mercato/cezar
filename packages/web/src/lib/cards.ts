import { cardNotStarted, type CardStageStatus, type RunRecord, type TaskAskRecord } from '@open-mercato/cezar-api-client'

import { isAwaitingAnswer } from './attention'

/**
 * Framework cards in the cockpit (spec 2026-11-15-framework-board § Tasks view): which column a
 * card sits in, what its row says, and what a drop on the board means. Pure, so the board, the
 * list and the wizard agree, and the drag rules (D12) are tested without a DOM.
 */

export type CardRun = RunRecord & { card: NonNullable<RunRecord['card']> }

export const isCard = (run: RunRecord): run is CardRun => run.card !== undefined

/** Backlog/Ready is the contract's `cardNotStarted`: a card re-queued mid-walk stays in its stage column. */
export { cardNotStarted }

/** Board columns around the framework's stages: Backlog, Ready, …stages, Ship (review), Done. */
export type CardColumnId = 'backlog' | 'ready' | 'ship' | 'done' | `stage:${string}`

export const stageColumn = (stage: string): CardColumnId => `stage:${stage}`
export const columnStage = (column: CardColumnId): string | undefined =>
  column.startsWith('stage:') ? column.slice('stage:'.length) : undefined

/** Where a card sits on the board. Ship is the run's own review gate (spec § Compilation). */
export function cardColumn(run: CardRun): CardColumnId {
  if (cardNotStarted(run)) return run.card.held ? 'backlog' : 'ready'
  switch (run.status) {
    case 'review':
      return 'ship'
    case 'done':
    case 'cancelled':
      return 'done'
    default:
      return stageColumn(run.card.stage)
  }
}

/** The stage columns: the active framework's stages, then any stage only an older card still has. */
export function boardStages(activeStages: readonly string[], cards: readonly CardRun[]): string[] {
  const out = [...activeStages]
  for (const run of cards) for (const stage of run.card.stageOrder) if (!out.includes(stage)) out.push(stage)
  return out
}

/** Ready order (D2): `card.order`, then creation — the order the scheduler drains. */
export function compareReady(a: CardRun, b: CardRun): number {
  const oa = a.card.order ?? Number.POSITIVE_INFINITY
  const ob = b.card.order ?? Number.POSITIVE_INFINITY
  return oa !== ob ? oa - ob : a.createdAt.localeCompare(b.createdAt)
}

/** Cards grouped by column, each column in its display order. */
export function cardsByColumn(cards: readonly CardRun[]): Map<CardColumnId, CardRun[]> {
  const map = new Map<CardColumnId, CardRun[]>()
  for (const run of cards) {
    const column = cardColumn(run)
    const list = map.get(column) ?? []
    list.push(run)
    map.set(column, list)
  }
  for (const [column, list] of map) {
    if (column === 'ready' || column === 'backlog') list.sort(compareReady)
    else list.sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
  }
  return map
}

/** "spec-review" → "Spec review" when no framework names it. */
export function humanizeStage(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : id
}

export type StageNames = ReadonlyMap<string, string>

export const stageName = (names: StageNames | undefined, id: string): string => names?.get(id) ?? humanizeStage(id)

/** The list's stage chip: `Spec review · 3/8` — position among the card's own stages. */
export function cardStageLabel(run: CardRun, names?: StageNames): string {
  const order = run.card.stageOrder
  const index = order.indexOf(run.card.stage)
  const name = stageName(names, run.card.stage)
  return index === -1 ? name : `${name} · ${index + 1}/${order.length}`
}

/** The newest ask the run is still waiting on — what a `gate.human` or a question parks behind. */
export function openAsk(run: RunRecord): TaskAskRecord | undefined {
  const asks = run.asks ?? []
  for (let i = asks.length - 1; i >= 0; i--) if (!asks[i]!.closed) return asks[i]
  return undefined
}

/** `approve: null` — a framework gate the framework confirms itself (SDD Discover's `done discover`). */
export type OpenGate = { stage: string; kind: 'human' | 'framework'; ask?: TaskAskRecord; approve?: string | null }

/** The gate the card is parked at, if any — the engine's `card.gate`, never a cursor guess. */
export function openGate(run: CardRun): OpenGate | undefined {
  const gate = run.card.gate
  if (run.status !== 'waiting' || !gate) return undefined
  const stage = run.card.stage
  if (gate.kind === 'approve') return { stage, kind: 'human', ask: openAsk(run) }
  return { stage, kind: 'framework', approve: gate.approve === undefined ? stage : gate.approve }
}

/** False for a gate cezar cannot approve: the framework confirms it with its own command. */
export const gateApprovable = (gate: OpenGate): boolean => gate.kind === 'human' || gate.approve !== null

/** Why a self-confirming framework gate has no Approve (SDD Discover). */
export const selfConfirmedReason = (gate: OpenGate): string =>
  `This stage is confirmed by the framework’s own \`done ${gate.stage}\` — there is nothing to approve in cezar.`

/** Parked in a conversation stage's turn (D10) — the engine's `card.conversation` flag, so a
 *  question park reads as a question and an interactive tail never offers Finish stage. */
export function inConversation(run: CardRun): boolean {
  return run.status === 'waiting' && !run.card.blocked && run.card.conversation === true
}

/**
 * The stage status every card surface shows. A `failed` run closed on an unanswered CEZ:ASK
 * (a restart ended the session) is still the user's question, not a failure — the record may
 * say `failed` for its stage, the cockpit says `waiting` (contract `runRecordSchema`).
 */
export function displayStageStatus(run: CardRun, stage: string): CardStageStatus | undefined {
  const status = run.card.stages[stage]
  return isAwaitingAnswer(run) && stage === run.card.stage && status !== 'done' && status !== 'skipped' ? 'waiting' : status
}

export type CardState = 'approve' | 'your-turn' | 'failed' | 'blocked' | 'question'

/** The row's state glyph: ⏸ approve, 💬 your turn, ✕ failed (mockup 0). */
export function cardState(run: CardRun): CardState | undefined {
  if (isAwaitingAnswer(run)) return 'question'
  if (run.status === 'failed') return 'failed'
  if (run.status !== 'waiting') return undefined
  if (run.card.blocked && run.card.blocked.reason !== 'gate') return 'blocked'
  if (openGate(run)) return 'approve'
  if (inConversation(run)) return 'your-turn'
  return openAsk(run) ? 'question' : undefined
}

export const CARD_STATE_LABEL: Record<CardState, string> = {
  approve: '⏸ approve',
  'your-turn': '💬 your turn',
  failed: '✕ failed',
  blocked: '⏸ blocked',
  question: '❓ question',
}

/** A card that needs a person: a gate, a conversation turn, a question (not WIP/precheck). */
export function needsYou(run: CardRun): boolean {
  const state = cardState(run)
  return state === 'approve' || state === 'your-turn' || state === 'question'
}

/** A card the cockpit should ask the framework about on focus (engine step 3). */
export const atFrameworkGate = (run: CardRun): boolean => openGate(run)?.kind === 'framework'

/** Focus recheck (engine step 3) also re-runs a refused precheck, so a fixed one starts by itself. */
export const wantsRecheck = (run: CardRun): boolean =>
  atFrameworkGate(run) || (run.status === 'waiting' && run.card.blocked?.reason === 'precheck')

/** The stage after `stage` on this card, skipping stages the card does not run. */
export function nextStage(run: CardRun, stage: string): string | undefined {
  const order = run.card.stageOrder
  for (let i = order.indexOf(stage) + 1; i > 0 && i < order.length; i++) {
    if (run.card.stages[order[i]!] !== 'skipped') return order[i]
  }
  return undefined
}

/** `rerunCard` is allowed on these (engine step 6). */
export const RERUNNABLE: ReadonlySet<RunRecord['status']> = new Set(['waiting', 'review', 'failed'])

export type DropOutcome =
  | { kind: 'noop' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'hold'; held: boolean }
  | { kind: 'reorder' }
  | { kind: 'approve'; gate: OpenGate; to: string }
  | { kind: 'rerun'; fromStage: string }

/**
 * What dropping `run` on `target` means (D12): Backlog ↔ Ready freely, reorder within Ready,
 * forward only onto the stage right after an open gate (= Approve), backward = Re-run from that
 * stage. Everything else is refused with the reason the toast shows.
 */
export function dropRule(run: CardRun, target: CardColumnId, names?: StageNames): DropOutcome {
  const from = cardColumn(run)
  const name = (stage: string) => stageName(names, stage)
  if (from === target) return from === 'ready' ? { kind: 'reorder' } : { kind: 'noop' }
  if (from === 'backlog' && target === 'ready') return { kind: 'hold', held: false }
  if (from === 'ready' && target === 'backlog') return { kind: 'hold', held: true }

  const targetStage = columnStage(target)
  if (from === 'backlog' || from === 'ready') {
    return targetStage
      ? { kind: 'refuse', reason: 'A card enters its first stage when an agent picks it up — move it to Ready.' }
      : { kind: 'refuse', reason: 'A card that has not started cannot skip to the end of the board.' }
  }
  if (target === 'backlog' || target === 'ready') {
    return { kind: 'refuse', reason: 'A started card cannot go back to the backlog — re-run it from a stage or cancel it.' }
  }
  if (target === 'ship' || target === 'done') {
    return { kind: 'refuse', reason: 'Ship and Done follow the run’s own review gate — a card is never moved there.' }
  }
  if (from === 'done') return { kind: 'refuse', reason: 'This card has finished — it cannot be moved.' }

  const stage = targetStage!
  const order = run.card.stageOrder
  if (!order.includes(stage)) return { kind: 'refuse', reason: `This card’s framework has no ${name(stage)} stage.` }
  if (run.card.stages[stage] === 'skipped') return { kind: 'refuse', reason: `This card skips ${name(stage)}.` }

  // Ship (review) sits after every stage: dropping it on a stage is always backwards.
  const fromIndex = from === 'ship' ? order.length : order.indexOf(run.card.stage)
  const toIndex = order.indexOf(stage)
  if (toIndex < fromIndex) {
    if (!RERUNNABLE.has(run.status)) {
      return { kind: 'refuse', reason: `Re-run from ${name(stage)} once the card is waiting, failed or at review — it is ${run.status} now.` }
    }
    return { kind: 'rerun', fromStage: stage }
  }
  const gate = openGate(run)
  if (!gate) return { kind: 'refuse', reason: 'A card moves forward only by approving an open gate — this one is not waiting at one.' }
  if (!gateApprovable(gate)) return { kind: 'refuse', reason: selfConfirmedReason(gate) }
  const next = nextStage(run, gate.stage)
  if (stage !== next) {
    return { kind: 'refuse', reason: `Approve moves one stage at a time — move it to ${next ? name(next) : 'the next stage'}.` }
  }
  return { kind: 'approve', gate, to: stage }
}

/** One row of the phone board's action sheet — the drag rules asked about one target each. */
export interface CardMove {
  id: 'ready' | 'backlog' | 'up' | 'down' | 'approve' | `rerun:${string}`
  label: string
  outcome: DropOutcome
  /** Set when the move is refused: the sheet shows it disabled, with this line under it. */
  reason?: string
  /** For up/down: the Ready slot the board's drop handler takes (drop BEFORE tile i). */
  readyIndex?: number
}

/**
 * The moves a phone offers instead of a drag (spec § Mobile board): every candidate is answered
 * by `dropRule`, so a refused one carries the same reason a refused drop toasts. `ready` is the
 * Ready column in display order, for Move up / Move down.
 */
export function cardMoves(run: CardRun, ctx: { names?: StageNames; ready?: readonly CardRun[] } = {}): CardMove[] {
  const { names } = ctx
  const ask = (id: CardMove['id'], label: string, target: CardColumnId, extra: Partial<CardMove> = {}): CardMove => {
    const outcome = dropRule(run, target, names)
    return { id, label, outcome, ...(outcome.kind === 'refuse' ? { reason: outcome.reason } : {}), ...extra }
  }
  const from = cardColumn(run)
  if (from === 'backlog') return [ask('ready', 'Move to Ready', 'ready')]
  if (from === 'ready') {
    const ready = ctx.ready ?? [run]
    const at = ready.findIndex((c) => c.id === run.id)
    const up = ask('up', 'Move up', 'ready', { readyIndex: at - 1 })
    const down = ask('down', 'Move down', 'ready', { readyIndex: at + 2 })
    return [
      ask('backlog', 'Back to Backlog', 'backlog'),
      at <= 0 ? { ...up, reason: up.reason ?? 'Already first in Ready — next up.' } : up,
      at === -1 || at >= ready.length - 1 ? { ...down, reason: down.reason ?? 'Already last in Ready.' } : down,
    ]
  }
  const out: CardMove[] = []
  const next = from.startsWith('stage:') ? nextStage(run, run.card.stage) : undefined
  if (next) out.push(ask('approve', `Approve & continue → ${stageName(names, next)}`, stageColumn(next)))
  const order = run.card.stageOrder
  const before = from === 'ship' || from === 'done' ? order : order.slice(0, Math.max(0, order.indexOf(run.card.stage)))
  for (const stage of before) out.push(ask(`rerun:${stage}`, `Re-run from ${stageName(names, stage)}`, stageColumn(stage)))
  return out
}

const ORDER_STEP = 1024

/**
 * The `order` PATCHes that put `movedId` at `toIndex` of the Ready list (D2). A midpoint between
 * two ordered neighbours when there is room — one request — else the whole list renumbered.
 */
export function reorderPatches(ready: readonly CardRun[], movedId: string, toIndex: number): { runId: string; order: number }[] {
  const rest = ready.filter((run) => run.id !== movedId)
  const moved = ready.find((run) => run.id === movedId)
  if (!moved) return []
  const at = Math.max(0, Math.min(toIndex, rest.length))
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)]
  if (next.every((run, i) => run.id === ready[i]?.id)) return []
  const prev = rest[at - 1]?.card.order
  const after = rest[at]?.card.order
  const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n)
  // Every card on the side we land against must already be ordered, or a midpoint lies.
  const orderedUpTo = rest.slice(0, at).every((run) => finite(run.card.order))
  const orderedFrom = rest.slice(at).every((run) => finite(run.card.order))
  if (orderedUpTo && orderedFrom) {
    if (finite(prev) && finite(after) && after - prev > 1e-6) return [{ runId: movedId, order: (prev + after) / 2 }]
    if (!finite(prev) && finite(after)) return [{ runId: movedId, order: after - ORDER_STEP }]
    if (finite(prev) && !finite(after)) return [{ runId: movedId, order: prev + ORDER_STEP }]
  }
  return next.flatMap((run, i) => {
    const order = (i + 1) * ORDER_STEP
    return run.card.order === order ? [] : [{ runId: run.id, order }]
  })
}

/** Stage strip cell tone (mockup 1 legend): done / running / waiting-for-you amber / failed. */
export type StripTone = 'done' | 'running' | 'waiting' | 'failed' | 'pending' | 'skipped'

export function stripTone(status: CardStageStatus | undefined): StripTone {
  switch (status) {
    case 'done':
      return 'done'
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'stale':
    case 'pending':
    default:
      return 'pending'
  }
}

/** The card tile's one most important line (mockup 1). */
export function cardHeadline(run: CardRun, names?: StageNames): string {
  const state = cardState(run)
  const cost = run.costUsd ? `$${run.costUsd.toFixed(2)}` : ''
  if (state === 'approve') {
    const gate = openGate(run)
    const stage = stageName(names, run.card.stage).toLowerCase()
    return gate && !gateApprovable(gate) ? `⏸ ${stage} — the framework confirms it` : `⏸ approve ${stage}`
  }
  if (state === 'your-turn') return '💬 your answer'
  if (state === 'question') return '❓ a question for you'
  if (state === 'failed') return `✕ ${stageName(names, run.card.stage)} failed`
  if (state === 'blocked') {
    const why = run.card.blocked?.reason === 'wip' ? 'stage full (WIP)' : 'precheck failed'
    return `⏸ ${why}`
  }
  if (run.status === 'queued') return cardNotStarted(run) && run.card.held ? 'draft' : 'waiting for a slot'
  if (run.status === 'review') return `🧑 ready to ship${cost ? ` · ${cost}` : ''}`
  if (run.status === 'done') return `merged${cost ? ` · ${cost}` : ''}`
  if (run.status === 'cancelled') return 'cancelled'
  const back = (run.card.history ?? []).filter((h) => h.text.startsWith('back to')).length
  if (back > 0) return `↻ ${back} back${cost ? ` · ${cost}` : ''}`
  const step = `step ${run.steps.filter((s) => s.status === 'done').length + 1}`
  return [run.runner, step, cost].filter(Boolean).join(' · ')
}

/** `#123` → GitHub, `ABC-12` → the tracker; anything else is kept as typed. */
export function parseIssueRef(text: string): { provider: string; ref: string } | undefined {
  const ref = text.trim()
  if (!ref) return undefined
  if (/^#?\d+$/.test(ref)) return { provider: 'github', ref: ref.startsWith('#') ? ref : `#${ref}` }
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(ref)) return { provider: 'tracker', ref }
  return { provider: 'other', ref }
}

/** The New-card form's slug default: same rule as the server's `slugify` (compile.ts). */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'card'
  )
}

/** A framework stage as the task view's rail shows it: one dot, its compiled nodes as sub-steps. */
export interface CardStageGroup<S extends { id: string } = { id: string }> {
  id: string
  name: string
  status: CardStageStatus
  steps: S[]
}

type GraphNodeLike = { id: string; stage?: string }

/**
 * Groups a card run's compiled steps by framework stage (spec 2026-11-15-framework-board): the
 * graph node's `stage` when the run carries its workflowDef, else the `<stage>-…` id convention
 * the compiler uses. A step neither places stays with the stage before it.
 */
export function cardStageGroups<S extends { id: string }>(
  run: CardRun & { steps: readonly S[]; workflowDef?: { graph?: { nodes?: readonly GraphNodeLike[] } } | null },
  names?: StageNames,
): CardStageGroup<S>[] {
  const order = run.card.stageOrder
  const byNode = new Map<string, string>()
  for (const node of run.workflowDef?.graph?.nodes ?? []) if (node.stage) byNode.set(node.id, node.stage)
  const byLength = [...order].sort((a, b) => b.length - a.length)
  const stageOf = (id: string): string | undefined => byNode.get(id) ?? byLength.find((stage) => id.startsWith(`${stage}-`))
  const groups = order.map((id) => ({ id, name: stageName(names, id), status: displayStageStatus(run, id) ?? 'pending', steps: [] as S[] }))
  const index = new Map(groups.map((g) => [g.id, g]))
  let last = groups[0]
  for (const step of run.steps) {
    const stage = stageOf(step.id)
    const group = (stage && index.get(stage)) || last
    if (!group) continue
    group.steps.push(step)
    last = group
  }
  return groups
}

/** `◆ <framework> · <Stage> · n/N` — the task view's header line for a card. */
export function cardHeaderLabel(run: CardRun, frameworkName: string, names?: StageNames): string {
  return `◆ ${frameworkName} · ${cardStageLabel(run, names)}`
}

/** The engine's "Finish this stage?" ask after `CEZ:STAGE-DONE` (D10) — the same labels as
 *  `STAGE_DONE_*` in packages/cezar/src/frameworks/card-runtime.ts. */
export const STAGE_DONE_HEADER = 'Finish stage'
export const STAGE_DONE_YES = 'Yes'
export const STAGE_DONE_NOT_YET = 'Not yet'

export function isStageDoneAsk(ask: { questions: readonly { header: string; options: readonly { label: string }[] }[] }): boolean {
  const [q, ...rest] = ask.questions
  if (!q || rest.length > 0 || q.header !== STAGE_DONE_HEADER) return false
  const labels = q.options.map((o) => o.label)
  return labels.includes(STAGE_DONE_YES) && labels.includes(STAGE_DONE_NOT_YET)
}

/** cezar's control markers never reach the reader: a trailing `CEZ:ASK {…}` block, and any
 *  `CEZ:STAGE-DONE` / `CEZ:VERDICT <name>` line. A safety net — the engine strips them too. */
export function stripControlMarkers(text: string): string {
  return text
    .replace(/(^|\n)[ \t]*CEZ:ASK[ \t]+\{[\s\S]*$/, '$1')
    .replace(/[ \t]*CEZ:STAGE-DONE[ \t]*(?=\n|$)/g, '')
    .replace(/[ \t]*CEZ:VERDICT[ \t:=]+[A-Za-z0-9][A-Za-z0-9_-]*[ \t]*(?=\n|$)/g, '')
    .replace(/^[ \t]*CEZ:ASK[ \t]*$/gm, '')
    .trimEnd()
}

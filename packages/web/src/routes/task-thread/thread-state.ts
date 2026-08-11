import type { RunEvent, RunStatus } from '@open-mercato/cezar-api-client'
import {
  toolDisplay,
  type PlanEntry,
  type PlanStatus,
  type StopReason,
  type UiAskQuestion,
  type UiItem,
  type UiToolItem,
} from '@open-mercato/cezar-api-client'

/**
 * The thread reducer: folds one run's ordered event list (`useRunEvents` — v1 lines and
 * protocol-v2 events over one `seq` clock) into renderable turns. Pure and total: called with
 * the full list on every render, it must never throw on a malformed line — one bad event costs
 * one event.
 *
 * Protocol v2 (`item.*`, `turn.*`, `plan.updated`) is primary. v1 lines fill two roles:
 *
 *  - Lines with NO v2 counterpart always render: `user-message` (the engine writes user turns
 *    as v1 only), `note`/`lifecycle` (dim lines), `error` (danger), `image` (persisted URL —
 *    the v2 `image` twin carries raw base64 and never reaches the file), `check-output`
 *    (check steps spawn no agent session, so v1 is all there is).
 *  - Item-ish lines (`text`, `tool-call`, `tool-result`) are a FALLBACK for old runs recorded
 *    before the v2 emitters existed. THE MIXED-FILE DEDUP RULE: within a turn, v2 wins — once
 *    any `item.*` event has been seen in the current turn, v1 item-ish lines are skipped, and
 *    any already-synthesized v1 items in that turn are dropped. This is grounded in the real
 *    wire order: the RunManager persists the mapper's v2 events *before* the v1 twin of the
 *    same content (observed in R2 dry-run transcripts: `item.completed` at seq N, its `text`
 *    twin at seq N+1), so the drop path also covers live streams, and the buffer-then-drop
 *    handles any interleaving the other way.
 *
 * v1-synthesized tool items are honest about what v1 knows: `running` on `tool-call`,
 * `completed` on `tool-result` — v1 has no failure/declined signal, so none is invented.
 */

/** A dim/danger transcript line (v1 note/lifecycle/error, v2 non-fatal session.error). */
export interface ThreadNote {
  kind: 'note'
  id: string
  text: string
  tone: 'dim' | 'danger'
}

/** An image the run persisted (v1 `image` line: served from `/api/runs/:id/images/…`). */
export interface ThreadImage {
  kind: 'image'
  id: string
  url: string
  name?: string
}

/**
 * A structured AskUser question the agent posed via `CEZ:ASK` (#473, v2
 * `ask.requested`). The cockpit renders it as clickable option chips. Resolution
 * is client-side: the next `user-message` for the run flips `resolved` and
 * records the reply as `answer`, so a reloaded thread reconstructs the same
 * resolved/pending state from the persisted stream.
 */
export interface ThreadAsk {
  kind: 'ask'
  id: string
  questions: UiAskQuestion[]
  resolved: boolean
  answer?: string
}

/** A persisted, cezar-owned recovery marker for a provider's runtime authentication failure. */
export interface ThreadProviderAuthRequired {
  kind: 'provider-auth-required'
  id: string
  provider: 'claude' | 'codex' | 'opencode' | 'pi'
  authFailureId: string
}

export type ThreadEntry = UiItem | ThreadNote | ThreadImage | ThreadAsk | ThreadProviderAuthRequired

export interface ThreadTurn {
  /** Stable source-derived render key. The opening event sequence survives prepended pages;
   *  ordinal fallback exists only for malformed legacy content with no boundary event. */
  id: string
  /** The protocol-v2 turnId, once known. */
  turnId?: string
  /** The v1 `user-message` that opened this turn. The FIRST turn usually has none — the initial
   *  prompt is the run's `task`, which the view renders from the run record. */
  userMessage?: { text: string; imageCount: number; images: string[] }
  items: ThreadEntry[]
  /** Latest `plan.updated` snapshot seen during this turn (full-replacement semantics). */
  planEntries?: PlanEntry[]
  completed?: { stopReason: StopReason; costUsd?: number }
}

export interface ThreadState {
  turns: ThreadTurn[]
  /** v2 `session.ended` — the last one wins (each step runs its own session). */
  sessionEnded?: { reason: StopReason; message?: string }
}

export interface ThreadReduceOptions {
  /** The current assistant turn still belongs to a running session. A complete
   * trailing ask block is provisional protocol text until turn-end either
   * emits its card or settles into the readable invalid-marker fallback. */
  activeTurn?: boolean
}

/** What the strip under the thread says. Pure so the mapping is table-testable. */
export type ThreadFooter =
  | { state: 'waiting' }
  | { state: 'closed'; label: string; tone: 'dim' | 'danger' }
  | null

/**
 * The plan the dock shows: the LATEST snapshot across all turns (full-replacement semantics —
 * every `plan.updated` supersedes everything before it, including one from an earlier turn).
 * An empty latest snapshot is returned as-is: it replaced the plan with nothing, which is not
 * the same as never having had one.
 */
export function latestPlanEntries(state: ThreadState): PlanEntry[] | undefined {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const entries = state.turns[i]!.planEntries
    if (entries !== undefined) return entries
  }
  return undefined
}

/**
 * Every file path the run's tool items are known to have touched (edit diffs + read/edit
 * locations), most recently touched first — TODAY'S source for the composer's `@` mentions.
 * R5's `/files` API replaces this with a worktree-wide search through the same composer seam
 * (`getMentionCandidates`); this stays as the offline-honest fallback.
 */
export function threadFilePaths(state: ThreadState): string[] {
  const seen: string[] = []
  for (const turn of state.turns) {
    for (const item of turn.items) {
      if (item.kind !== 'tool') continue
      for (const location of item.locations ?? []) seen.push(location.path)
      for (const diff of item.diffs ?? []) seen.push(diff.path)
    }
  }
  // Later mention beats earlier: keep each path's LAST occurrence, then newest first.
  const deduped: string[] = []
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    if (!deduped.includes(seen[i]!)) deduped.push(seen[i]!)
  }
  return deduped
}

export function threadFooter(status: RunStatus, error?: string): ThreadFooter {
  switch (status) {
    case 'waiting':
      return { state: 'waiting' }
    case 'failed':
      return { state: 'closed', tone: 'danger', label: error ? `Session failed — ${error}` : 'Session failed' }
    case 'review':
      return { state: 'closed', tone: 'dim', label: 'Session closed — waiting for your review' }
    case 'done':
    case 'cancelled':
      return { state: 'closed', tone: 'dim', label: 'Session closed' }
    default:
      // queued/running: the stream itself is the status.
      return null
  }
}

// ---- internals ----------------------------------------------------------------------------

/** `origin` is fold-internal: it is what lets the mixed-file rule drop exactly the v1-derived
 *  items and nothing else when a turn turns out to be v2-covered. */
interface DraftEntry {
  origin: 'v1' | 'v2' | 'meta'
  entry: ThreadEntry
}

interface DraftTurn {
  id: string
  turnId?: string
  userMessage?: { text: string; imageCount: number; images: string[] }
  entries: DraftEntry[]
  planEntries?: PlanEntry[]
  completed?: { stopReason: StopReason; costUsd?: number }
  /** True once any v2 `item.*` event landed in this turn — the dedup latch. */
  v2Items: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function providerId(value: unknown): ThreadProviderAuthRequired['provider'] | undefined {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'pi'
    ? value
    : undefined
}

/** The engine's turn-end markers (`CEZ:DONE`, `CEZ:MONITORING` from #490) plus the in-band
 *  task-reference marker lines (`CEZ:PR=` / `CEZ:ISSUE=` / `CEZ:TITLE=`, spec
 *  2026-07-18-task-ref-markers). v1 `text` lines arrive pre-stripped by the server; v2 message
 *  items carry the raw text, so display strips them here. Named `stripDoneMarker` for
 *  continuity — it now strips every protocol marker. Mirrors `stripTaskMarkers` in
 *  `src/runs/task-markers.ts`.
 *
 *  `stripAsk` gates the `CEZ:ASK` strip on the turn actually holding an ask card (#473): the
 *  card is the only other place the questions exist, so a marker whose card never materialized
 *  (invalid payload, or the session died before turn-end) must stay visible as raw text — the
 *  user can still read the question and answer via the composer. Hiding it would delete the
 *  question from the thread entirely. */
function stripDoneMarker(text: string, stripAsk: boolean): string {
  let trailing = text
    .replace(/\s*CEZ:DONE\s*$/, '')
    .replace(/\s*CEZ:MONITORING\s*$/, '')
  if (stripAsk) trailing = trailing.replace(/\s*CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/, '')
  if (!trailing.includes('CEZ:')) return trailing
  return trailing
    .split('\n')
    .filter((line) => !/^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/.test(line))
    .join('\n')
}

/**
 * Repair for legacy per-delta transcripts: codex/opencode runs recorded before the runners
 * coalesced v1 `text` per item persisted one `text` line PER STREAMING TOKEN, so the fold
 * synthesized one message per token ("github" / ".com" / "merc" / "ato" …, each its own
 * paragraph) and the exact-match dedup never fired — no single token equals the v2 message.
 * The tokens ARE the v2 message, just cut up: a run of consecutive v1 messages whose
 * concatenation reassembles a v2 message of the turn (or all of them in order, when v1 tool
 * suppression made several messages adjacent) is dropped as a whole; the v2 twin renders.
 * The comparison ignores whitespace — the server dropped whitespace-only deltas at persist
 * time — and strips markers on the CONCATENATION, catching `CEZ:DONE` split across tokens,
 * which per-event stripping let through. A run that reassembles nothing is kept untouched.
 */
function dropLegacyDeltaRuns(draft: DraftTurn): void {
  // Marker-insensitive comparison (stripAsk: true): the v1 side may or may not carry the
  // marker depending on server-side validation, so equality must ignore it either way.
  const norm = (text: string) => stripDoneMarker(text, true).replace(/\s+/g, '')
  const v2Norms = new Set<string>()
  const inOrder: string[] = []
  for (const { origin, entry } of draft.entries) {
    if (origin === 'v2' && entry.kind === 'message') {
      const n = norm(entry.text)
      v2Norms.add(n)
      inOrder.push(n)
    }
  }
  if (inOrder.length === 0) return
  v2Norms.add(inOrder.join(''))
  const kept: DraftEntry[] = []
  let run: { entries: DraftEntry[]; texts: string[] } = { entries: [], texts: [] }
  const flushRun = () => {
    // Single entries already had their chance in the exact-match filter above — only a
    // genuine run (≥2 fragments) is a delta artifact worth reassembling.
    if (run.entries.length >= 2 && v2Norms.has(norm(run.texts.join('')))) {
      run = { entries: [], texts: [] }
      return
    }
    kept.push(...run.entries)
    run = { entries: [], texts: [] }
  }
  for (const e of draft.entries) {
    if (e.origin === 'v1' && e.entry.kind === 'message') {
      run.entries.push(e)
      run.texts.push(e.entry.text)
    } else {
      flushRun()
      kept.push(e)
    }
  }
  flushRun()
  draft.entries = kept
}

/** v1 tool results are strings today; anything else is rendered as JSON rather than dropped. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const isUiItem = (entry: ThreadEntry): entry is UiItem =>
  entry.kind === 'message' || entry.kind === 'reasoning' || entry.kind === 'tool'

/** Every `PlanStatus`, so an unrecognized status is the only thing that falls back to
 *  `pending` below. `Set<PlanStatus>` accepts a subset without complaint, so this list
 *  has to be kept honest by hand when the union grows. */
const PLAN_STATUSES: ReadonlySet<string> = new Set<PlanStatus>(['pending', 'in_progress', 'completed', 'cancelled'])

/**
 * Pre-v2 transcripts carry the plan only as TodoWrite input (`{todos: [{content, status,
 * activeForm}]}` — the documented Claude wire shape). Recovered so old runs get the dock too;
 * v2-covered turns never need this (their mappers emit `plan.updated`). All-or-nothing: one
 * malformed entry means the input is not the shape we claim to understand.
 */
function planFromTodos(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined
  const entries: PlanEntry[] = []
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') return undefined
    entries.push({
      content: todo.content,
      status: PLAN_STATUSES.has(todo.status as string) ? (todo.status as PlanStatus) : 'pending',
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
    })
  }
  return entries
}

export function reduceThread(events: RunEvent[], options: ThreadReduceOptions = {}): ThreadState {
  const turns: DraftTurn[] = []
  /** stepId:itemId → live item. Runner sessions restart ids at `item_1`, while every current
   *  persisted event is stamped with its workflow step. Old recordings without a step id keep
   *  the historical bare-id lookup semantics. */
  const itemsById = new Map<string, { turn: DraftTurn; entry: DraftEntry }>()
  let sessionEnded: ThreadState['sessionEnded']
  let turnSeq = 0
  /** The latest unresolved AskUser card (#473). The next `user-message` resolves
   *  it client-side (only one ask is ever pending — the agent asks once, then
   *  parks `waiting` until the user answers). */
  let pendingAsk: ThreadAsk | undefined

  const newTurn = (sourceSeq?: number): DraftTurn => {
    turnSeq += 1
    const turn: DraftTurn = {
      id: sourceSeq === undefined ? `turn-fallback-${turnSeq}` : `turn-seq-${sourceSeq}`,
      entries: [],
      v2Items: false,
    }
    turns.push(turn)
    return turn
  }
  const currentTurn = (): DraftTurn => turns.at(-1) ?? newTurn()

  const itemKey = (event: RunEvent, itemId: string) => {
    const stepId = str(event.stepId)
    return stepId === undefined ? itemId : `${stepId}:${itemId}`
  }

  const upsertV2 = (turn: DraftTurn, raw: UiItem, key: string) => {
    // Clone: deltas append in place, and the event object off the wire must stay untouched.
    const item = { ...raw }
    if (!turn.v2Items) {
      // The dedup latch flips: this turn is v2-covered, so every v1-synthesized TOOL in it is
      // a duplicate of something v2 already describes (or is about to). Tools can be dropped
      // sight-unseen because v2 tool coverage is total across backends and ids are shared —
      // `tool-call`'s own `turn.v2Items` guard already suppresses the rest.
      //
      // v1 MESSAGES are deliberately NOT dropped here (#agent-log-vanishing-text): a turn being
      // v2-covered for tools does NOT prove its prose has a v2 twin. Claude's result fallback
      // (claude-cli-runner.ts emits a v1 `text` from `msg.result`) had no v2 counterpart, so
      // this blanket drop deleted the agent's only message a moment after it rendered. The
      // twinned ones are removed by text at the end of the fold, where the evidence exists.
      turn.v2Items = true
      for (const dropped of turn.entries) {
        if (dropped.origin === 'v1' && dropped.entry.kind === 'tool') itemsById.delete(dropped.entry.id)
      }
      turn.entries = turn.entries.filter((e) => !(e.origin === 'v1' && e.entry.kind === 'tool'))
    }
    const existing = itemsById.get(key)
    if (existing && existing.turn === turn) {
      existing.entry.entry = item
      itemsById.set(key, existing)
      return
    }
    const draft: DraftEntry = { origin: 'v2', entry: item }
    turn.entries.push(draft)
    itemsById.set(key, { turn, entry: draft })
  }

  for (const event of events) {
    switch (event.type) {
      // ---- turn boundaries ------------------------------------------------------------
      case 'user-message': {
        const text = str(event.text) ?? ''
        // Client-side resolution of the pending AskUser card (#473): the reply
        // that follows an ask closes it and records the answer.
        if (pendingAsk && !pendingAsk.resolved) {
          pendingAsk.resolved = true
          if (text !== '') pendingAsk.answer = text
          pendingAsk = undefined
        }
        const turn = newTurn(event.seq)
        turn.userMessage = {
          text,
          imageCount: typeof event.imageCount === 'number' ? event.imageCount : 0,
          images: Array.isArray(event.images) ? event.images.filter((u): u is string => typeof u === 'string') : [],
        }
        break
      }
      case 'turn.started': {
        const turnId = str(event.turnId)
        const current = turns.at(-1)
        // A v1 `user-message` line precedes the v2 turn.started for the same turn (observed
        // wire order) — attach rather than opening a duplicate. A turn that already has a v2
        // identity or v2 items is someone else's; open fresh.
        if (current && current.turnId === undefined && !current.v2Items) {
          current.turnId = turnId
        } else {
          newTurn(event.seq).turnId = turnId
        }
        break
      }
      case 'turn.completed': {
        const turnId = str(event.turnId)
        // Newest match first (lib is ES2022, so no findLast): per-session turn ids repeat
        // across steps, and a completion always belongs to the most recent turn wearing it.
        let matched: DraftTurn | undefined
        for (let i = turns.length - 1; i >= 0 && !matched; i -= 1) {
          if (turns[i]!.turnId === turnId) matched = turns[i]
        }
        const turn = matched ?? turns.at(-1)
        if (turn) {
          turn.completed = {
            stopReason: (str(event.stopReason) ?? 'end_turn') as StopReason,
            ...(typeof event.costUsd === 'number' ? { costUsd: event.costUsd } : {}),
          }
        }
        break
      }

      // ---- v2 items ---------------------------------------------------------------------
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        // Validate the discriminant AND the id before trusting the cast: an unknown `kind` would
        // render a blank row, and a missing `id` would key every such item to the same
        // `${turn}:undefined` (duplicate React keys) — #minor-item-ingress-guard.
        if (!isRecord(event.item)) break
        const kind = event.item.kind
        const id = event.item.id
        if (
          (kind !== 'message' && kind !== 'reasoning' && kind !== 'tool') ||
          typeof id !== 'string' ||
          id === ''
        ) {
          break
        }
        const item = event.item as unknown as UiItem
        const key = itemKey(event, item.id)
        const located = itemsById.get(key)
        upsertV2(located?.turn ?? currentTurn(), item, key)
        break
      }
      case 'item.delta': {
        const itemId = str(event.itemId) ?? ''
        const located = itemsById.get(itemKey(event, itemId))
        const delta = str(event.delta) ?? ''
        if (!located || delta === '' || !isUiItem(located.entry.entry)) break
        const item = located.entry.entry
        if (event.field === 'output' && item.kind === 'tool') {
          item.output = (item.output ?? '') + delta
        } else if (event.field !== 'output' && item.kind !== 'tool') {
          item.text += delta
        }
        break
      }

      // ---- v1 fallback items (skipped once the turn is v2-covered) -----------------------
      case 'text': {
        // No `v2Items` guard, unlike `tool-call` below: whether this line has a v2 twin is
        // decided by TEXT at the end of the fold, not by the latch. Suppressing it here would
        // lose any prose v2 never described (claude's `msg.result` fallback).
        const turn = currentTurn()
        const text = str(event.text) ?? ''
        if (text === '') break
        turn.entries.push({
          origin: 'v1',
          entry: { kind: 'message', id: `v1:${event.seq}`, role: 'assistant', text },
        })
        break
      }
      case 'tool-call': {
        const turn = currentTurn()
        if (turn.v2Items) break
        const name = str(event.tool) ?? 'Tool'
        // Codex collaboration bookkeeping has no user-facing meaning. Protocol
        // v2 normalizes it into task rows and parented child tools; old/mixed
        // recordings can still carry a receiver-less v1 wait in a child turn.
        if (CODEX_COLLAB_BOOKKEEPING.has(name)) break
        const display = toolDisplay(name, event.input)
        if (display.toolKind === 'plan') {
          // v1-only fallback: the dock's data lives in the TodoWrite input on old transcripts.
          const plan = planFromTodos(event.input)
          if (plan !== undefined) turn.planEntries = plan
        }
        const item: UiToolItem = {
          kind: 'tool',
          id: str(event.id) ?? `v1:${event.seq}`,
          name,
          toolKind: display.toolKind,
          title: display.title,
          status: 'running',
          input: event.input,
        }
        const draft: DraftEntry = { origin: 'v1', entry: item }
        turn.entries.push(draft)
        itemsById.set(item.id, { turn, entry: draft })
        break
      }
      case 'tool-result': {
        const located = itemsById.get(str(event.toolCallId) ?? '')
        if (!located || located.turn.v2Items || located.entry.origin !== 'v1') break
        const item = located.entry.entry
        if (item.kind !== 'tool') break
        item.status = 'completed'
        item.output = resultText(event.result)
        break
      }

      // ---- lines that always render -------------------------------------------------------
      case 'note':
      case 'lifecycle': {
        const text = str(event.message) ?? ''
        if (text === '') break
        currentTurn().entries.push({
          origin: 'meta',
          entry: { kind: 'note', id: `v1:${event.seq}`, text, tone: 'dim' },
        })
        break
      }
      case 'error': {
        const text = str(event.message) ?? ''
        if (text === '') break
        currentTurn().entries.push({
          origin: 'meta',
          entry: { kind: 'note', id: `v1:${event.seq}`, text, tone: 'danger' },
        })
        break
      }
      case 'session.error': {
        const text = str(event.message) ?? ''
        if (text === '') break
        currentTurn().entries.push({
          origin: 'meta',
          entry: { kind: 'note', id: `v2:${event.seq}`, text, tone: 'danger' },
        })
        break
      }
      case 'step-end': {
        // Steps stay out of the thread (they are header material) except the one thing the
        // transcript must not hide: a step that failed — mirroring the legacy renderer.
        if (event.status !== 'failed') break
        const suffix = str(event.error) ? ` — ${str(event.error)}` : ''
        currentTurn().entries.push({
          origin: 'meta',
          entry: { kind: 'note', id: `v1:${event.seq}`, text: `step ${str(event.stepId) ?? '?'} failed${suffix}`, tone: 'danger' },
        })
        break
      }
      case 'check-output': {
        // A check step's command run (`src/workflows/run.ts` — v1-only: check steps spawn no
        // agent session, so no v2 twin exists). Rendered as an execute tool card so the
        // pass/fail verdict rides the exit-code pill; origin `meta` because it is not an
        // agent item and must survive the mixed-file dedup.
        const command = str(event.command) ?? 'check'
        const exitCode = typeof event.exitCode === 'number' ? event.exitCode : -1
        const item: UiToolItem = {
          kind: 'tool',
          id: `v1:${event.seq}`,
          name: 'check',
          toolKind: 'execute',
          title: `Ran ${command}`,
          status: exitCode === 0 ? 'completed' : 'failed',
          output: str(event.text) ?? '',
          exitCode,
        }
        currentTurn().entries.push({ origin: 'meta', entry: item })
        break
      }
      case 'provider-auth-required': {
        // Cezar-owned persisted metadata: accept only the closed provider set and an opaque,
        // bounded incident id. A malformed historical/future line costs itself, never a turn.
        const provider = providerId(event.provider)
        const authFailureId = str(event.authFailureId)
        if (provider === undefined || authFailureId === undefined || authFailureId.length < 1 || authFailureId.length > 128) break
        currentTurn().entries.push({
          origin: 'meta',
          entry: { kind: 'provider-auth-required', id: `v1:${event.seq}`, provider, authFailureId },
        })
        break
      }
      case 'image': {
        // Only the v1 line carries a served URL; the v2 twin is raw base64 and is dropped by
        // the sink before persistence anyway. No URL → nothing honest to render.
        const url = str(event.url)
        if (url === undefined) break
        const entry: ThreadImage = { kind: 'image', id: `v1:${event.seq}`, url }
        const name = str(event.name)
        if (name !== undefined) entry.name = name
        currentTurn().entries.push({ origin: 'meta', entry })
        break
      }

      // ---- session-level --------------------------------------------------------------------
      case 'plan.updated': {
        if (Array.isArray(event.entries)) {
          currentTurn().planEntries = event.entries as PlanEntry[]
        }
        break
      }
      case 'session.ended': {
        sessionEnded = {
          reason: (str(event.reason) ?? 'end_turn') as StopReason,
          ...(str(event.message) !== undefined ? { message: str(event.message) } : {}),
        }
        break
      }
      case 'ask.requested': {
        // A structured question (#473) — render it as an ask card in the current
        // turn. Guard the payload (a bad line costs one event, never a throw).
        const requestId = str(event.requestId)
        if (requestId === undefined || !Array.isArray(event.questions)) break
        const questions = (event.questions as unknown[]).filter(
          (q): q is UiAskQuestion =>
            isRecord(q) && typeof q.header === 'string' && Array.isArray(q.options),
        )
        if (questions.length === 0) break
        const ask: ThreadAsk = { kind: 'ask', id: requestId, questions, resolved: false }
        currentTurn().entries.push({ origin: 'meta', entry: ask })
        pendingAsk = ask
        break
      }

      // ---- THE v1 VOCABULARY SWEEP (cezar-code-map §3.2) — deliberate suppressions ---------
      // Every persisted v1 type is either rendered above or named here with the surface that
      // owns it instead, so an old transcript reads complete without transcript noise:
      //  - `step-start` / non-failed `step-end`: the run header's step rail (step-rail.tsx)
      //    is the steps surface, same as the legacy divider-free design choice for step ends.
      //  - `token-usage` / `cost`: the header meta line renders the RECORD's running totals;
      //    per-event ticks in the body would just repaint the same numbers.
      //  - `turn-end` / `done`: pure engine control flow — completion already reads from the
      //    run status footer (and `done` is always shadowed by a `lifecycle` line).
      //  - `session`: the backend's session id, surfaced by the header's take-over hint via
      //    the record's `sessionId` — an id line in the transcript helps no one.
      case 'step-start':
      case 'token-usage':
      case 'cost':
      case 'turn-end':
      case 'done':
      case 'session':
        break

      // session.started, usage.updated, permission.* and anything future: header/telemetry
      // material or not yet rendered — never guessed at in the thread body. (Deliberate
      // divergence from the legacy raw-JSON-note fallback: an unknown type renders as
      // nothing rather than as debug output.)
      default:
        break
    }
  }

  // The message half of the mixed-file dedup, resolved once the whole turn is known: a v1
  // `text` line is a duplicate exactly when some v2 message item in the same turn carries the
  // same prose — which is the normal claude/codex/opencode path, where the v2 item lands first
  // and its v1 twin one line later. Comparison is on marker-stripped, trimmed text because the
  // two arrive differently normalized: the server strips `CEZ:` markers from v1 `text` before
  // persisting, while v2 items carry the raw text and are stripped below at render time.
  // Anything left unmatched is prose that exists ONLY in v1 — it renders rather than vanishing.
  for (const draft of turns) {
    if (!draft.v2Items) continue
    const v2Texts = new Set<string>()
    for (const { origin, entry } of draft.entries) {
      // stripAsk: true — dedup equality must ignore the marker on both sides (see norm()).
      if (origin === 'v2' && entry.kind === 'message') v2Texts.add(stripDoneMarker(entry.text, true).trim())
    }
    if (v2Texts.size === 0) continue
    draft.entries = draft.entries.filter(
      (e) =>
        !(e.origin === 'v1' && e.entry.kind === 'message' && v2Texts.has(stripDoneMarker(e.entry.text, true).trim())),
    )
    dropLegacyDeltaRuns(draft)
  }

  return {
    turns: turns.map((draft, index) => {
      // The ask card renders the questions, so only then is the marker redundant (#473).
      const hasAskCard = draft.entries.some(({ entry }) => entry.kind === 'ask')
      // A completed v2 assistant item lands before the v1 turn-end handler can
      // parse the marker and emit ask.requested. Hide that provisional transport
      // block only on the live latest turn. Once the run leaves `running`, a
      // hard-invalid marker returns as readable fallback (#671).
      const provisionalAsk = options.activeTurn === true && index === turns.length - 1
      return {
        id: draft.id,
        ...(draft.turnId !== undefined ? { turnId: draft.turnId } : {}),
        ...(draft.userMessage !== undefined ? { userMessage: draft.userMessage } : {}),
        ...(draft.planEntries !== undefined ? { planEntries: draft.planEntries } : {}),
        ...(draft.completed !== undefined ? { completed: draft.completed } : {}),
        items: draft.entries.map(({ entry }) =>
          entry.kind === 'message' && entry.role === 'assistant'
            ? { ...entry, text: stripDoneMarker(entry.text, hasAskCard || provisionalAsk) }
            : entry,
        ),
      }
    }),
    ...(sessionEnded !== undefined ? { sessionEnded } : {}),
  }
}

const CODEX_COLLAB_BOOKKEEPING = new Set(['subAgentActivity', 'collabAgentToolCall', 'collabToolCall'])

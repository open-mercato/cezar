/**
 * Normalized agent-event protocol v2 — the api-client's mirror of
 * `src/core/ui-events.ts` (Step 2.4 of the R2 plan).
 *
 * Why a mirror and not an import: the server original lives in the NodeNext
 * program next to the runners that emit these events, and the types are the
 * contract, not the module graph. The mirror is *checked*, not trusted:
 * `src/server/api-types.test.ts` asserts type exactness between every
 * declaration here and the server's own, so a drift fails
 * `npm run typecheck` (the gate) instead of the UI at runtime.
 *
 * This module MUST stay import-free so the NodeNext-side guard can reach it.
 * The field-level contract docs (per-backend mappings, ACP rationale) live on
 * the server original — they are about how runners EMIT these events; this
 * side only consumes them.
 */

/** The backend that produced a session. */
export type UiBackend = 'claude' | 'codex' | 'opencode' | 'pi'

/** Tool lifecycle status (ACP-aligned; `running` ≡ ACP `in_progress`). */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined'

/** Icon/verb hint for a tool item — a superset of ACP's ToolKind. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'task'
  | 'plan'
  | 'other'

/** Why a turn (or the session) stopped. */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'timeout' | 'error'

/** Status of one plan/todo entry. `cancelled` ("no longer needed") is
 *  opencode-only today — it renders struck through and drops out of the
 *  odometer's denominator rather than reading as unfinished work. */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** One entry of the session plan — full-replacement semantics (ACP style). */
export interface PlanEntry {
  content: string
  status: PlanStatus
  priority?: 'high' | 'medium' | 'low'
  /** Present-continuous label shown while the entry is in progress. */
  activeForm?: string
}

/** Raw token counts — never pre-weighted (cost weighting is presentation). */
export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  /** The backend's own total when given, else the sum of the parts. */
  total: number
  /** Model context-window size when known — feeds the fill gauge. */
  contextWindow?: number
}

/** One file change carried by an edit-tool item. `oldText: null` = new file. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText?: string
  unified?: string
}

/** A file location a tool touched (feeds "jump to file" affordances). */
export interface ToolLocation {
  path: string
  line?: number
}

/** A choice offered by a permission request (ACP option kinds). */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface PermissionOption {
  id: string
  label: string
  kind: PermissionOptionKind
}

/* ------------------------------------------------------------------ */
/* Items — ONE id-keyed stream for text, reasoning and tools           */
/* ------------------------------------------------------------------ */

/** A chat message. */
export interface UiMessageItem {
  kind: 'message'
  id: string
  role: 'assistant' | 'user'
  text: string
  phase?: 'commentary' | 'final'
  parentItemId?: string
}

/** Extended thinking / reasoning summary. */
export interface UiReasoningItem {
  kind: 'reasoning'
  id: string
  text: string
  parentItemId?: string
}

/** One tool invocation with its full lifecycle. */
export interface UiToolItem {
  kind: 'tool'
  id: string
  /** The backend's tool name / item type (e.g. `Bash`, `commandExecution`). */
  name: string
  /** ACP-style icon/verb hint — see `toolDisplay()` in `tool-display.ts`. */
  toolKind: ToolKind
  /** Human line, computed once in the protocol layer: "Ran npm test". */
  title: string
  status: ToolStatus
  /** Raw input — may arrive incrementally. */
  input?: unknown
  output?: string
  error?: string
  diffs?: FileDiff[]
  locations?: ToolLocation[]
  /** commandExecution / bash exit code, when the backend reports one. */
  exitCode?: number
  parentItemId?: string
}

export type UiItem = UiMessageItem | UiReasoningItem | UiToolItem

/* ------------------------------------------------------------------ */
/* Events — discriminated on `type`                                    */
/* ------------------------------------------------------------------ */

/** Session opened. */
export interface UiSessionStartedEvent {
  type: 'session.started'
  sessionId: string
  backend: UiBackend
  model?: string
  cwd?: string
  tools?: string[]
}

/** Session over (replaces v1 `done` / fatal `error`). */
export interface UiSessionEndedEvent {
  type: 'session.ended'
  reason: StopReason
  message?: string
}

/** v1 `note` + `error` unified — severity explicit instead of implied. */
export interface UiSessionErrorEvent {
  type: 'session.error'
  message: string
  fatal: boolean
}

/** A turn began. */
export interface UiTurnStartedEvent {
  type: 'turn.started'
  turnId: string
}

/** A turn finished. */
export interface UiTurnCompletedEvent {
  type: 'turn.completed'
  turnId: string
  stopReason: StopReason
  usage?: TokenUsage
  costUsd?: number
}

/** An item entered the stream (tools usually with status pending/running). */
export interface UiItemStartedEvent {
  type: 'item.started'
  item: UiItem
}

/**
 * Streaming append to one field of a live item. On the wire these are
 * EPHEMERAL: the server coalesces them (~40 ms) onto the live SSE stream
 * only, so their `seq` values never reappear in a replay — dedup must use
 * `>`, never sequence-gap detection.
 */
export interface UiItemDeltaEvent {
  type: 'item.delta'
  itemId: string
  field: 'text' | 'reasoning' | 'output'
  delta: string
}

/** Status flips and streamed-content snapshots. */
export interface UiItemUpdatedEvent {
  type: 'item.updated'
  item: UiItem
}

/** Final snapshot of an item — safe to persist (snapshots, not deltas). */
export interface UiItemCompletedEvent {
  type: 'item.completed'
  item: UiItem
}

/** Full-replacement plan snapshot (ACP semantics). */
export interface UiPlanUpdatedEvent {
  type: 'plan.updated'
  entries: PlanEntry[]
}

/** RESERVED — wired when auto-approve becomes optional. Types only for now. */
export interface UiPermissionRequestedEvent {
  type: 'permission.requested'
  requestId: string
  itemId?: string
  title: string
  options: PermissionOption[]
}

/** RESERVED — the counterpart resolution (see `permission.requested`). */
export interface UiPermissionResolvedEvent {
  type: 'permission.resolved'
  requestId: string
  optionId: string
}

/** One option in an AskUser question — see the server `src/core/ask.ts`. */
export interface UiAskOption {
  label: string
  description?: string
}

/** One structured multiple-choice question (modeled on `AskUserQuestion`). */
export interface UiAskQuestion {
  id?: string
  header: string
  question: string
  options: UiAskOption[]
  multiSelect?: boolean
}

/**
 * The agent asked the user a structured multiple-choice question via a
 * `CEZ:ASK` marker. The run parks `waiting`; the cockpit renders clickable
 * option chips. Resolution is client-side (the next user message closes the
 * card) — there is no `ask.resolved` event.
 */
export interface UiAskRequestedEvent {
  type: 'ask.requested'
  requestId: string
  questions: UiAskQuestion[]
}

/** Cumulative-for-session raw telemetry. */
export interface UiUsageUpdatedEvent {
  type: 'usage.updated'
  usage: TokenUsage
  costUsd?: number
}

/** An image emitted mid-stream (kept from v1) — raw base64 on the wire. */
export interface UiImageEvent {
  type: 'image'
  itemId?: string
  mediaType: string
  data: string
}

export type UiEvent =
  | UiSessionStartedEvent
  | UiSessionEndedEvent
  | UiSessionErrorEvent
  | UiTurnStartedEvent
  | UiTurnCompletedEvent
  | UiItemStartedEvent
  | UiItemDeltaEvent
  | UiItemUpdatedEvent
  | UiItemCompletedEvent
  | UiPlanUpdatedEvent
  | UiPermissionRequestedEvent
  | UiPermissionResolvedEvent
  | UiAskRequestedEvent
  | UiUsageUpdatedEvent
  | UiImageEvent

/** Every v2 event discriminator. */
export type UiEventType = UiEvent['type']

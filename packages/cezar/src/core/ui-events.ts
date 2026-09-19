/**
 * Normalized agent-event protocol v2 — the shared vocabulary every runner
 * emits ALONGSIDE the v1 `AgentEvent` stream (never replacing it; mixed
 * NDJSON files stay valid — old recordings must keep replaying).
 *
 * Contract sources (authoritative, in this order):
 *  - `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §7 (schema)
 *    and §7.1 (per-backend mapping tables);
 *  - the spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`
 *    §"Normalized agent-event protocol v2".
 *
 * Design rules baked in:
 *  1. Item-lifecycle model (Codex/ACP style): one stable `id` per item with
 *     started/delta/updated/completed phases — two of the three backends are
 *     natively item-shaped and claude maps trivially.
 *  2. ACP vocabulary wherever a choice is arbitrary (tool status/kind, plan
 *     entries, diff shape, stop reasons) for ecosystem alignment.
 *  3. Every v1 `AgentEvent` stays derivable from this stream, so consumers
 *     can migrate one panel at a time.
 *
 * This module is pure vocabulary: no runtime imports, no runner coupling.
 * Mirrored into `packages/api-client/src/protocol/`.
 */

/** The backend that produced a session — mirrors `RunnerId` in
 *  `agent-runner.ts` (kept structurally identical; a type-level test
 *  guards against drift so this module stays dependency-free). */
export type UiBackend = 'claude' | 'codex' | 'opencode' | 'pi';

/**
 * Tool lifecycle status (ACP: pending/in_progress/completed/failed).
 * `running` ≡ ACP `in_progress` (opencode's word — reads better in code);
 * `declined` covers codex approval declines and claude `permission_denials`.
 *
 * Per backend: claude has no pending phase (`tool_use` arrives already
 * running); codex maps `inProgress→running`, `completed/failed/declined`
 * verbatim; opencode maps `pending/running` verbatim and `error→failed`.
 */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';

/**
 * Icon/verb hint for a tool item — a superset of ACP's ToolKind.
 * `task` = subagent spawn (claude Task / opencode subtask / codex review).
 */
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
  | 'other';

/**
 * Why a turn (or the session) stopped.
 *
 * Per backend: claude `result` subtype success→`end_turn`,
 * error_max_turns→`max_tokens`, error_during_execution→`error`; codex
 * turn/completed→`end_turn`, turn/failed→`error`, interrupt→`cancelled`;
 * opencode `session.idle`→`end_turn` (or `error` when a session.error
 * preceded it).
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'timeout' | 'error';

/**
 * Status of one plan/todo entry. claude TodoWrite/TaskUpdate use the first
 * three words verbatim; codex `turn/plan/updated` sends camelCase
 * (`inProgress`) and is normalized here; opencode `todowrite` adds
 * `cancelled` ("no longer needed") — its status field is a free-form string
 * whose documented vocabulary is pending|in_progress|completed|cancelled.
 *
 * `cancelled` is opencode-only today. It is a first-class status rather than a
 * dropped row: an abandoned todo must stay visible (struck through) instead of
 * silently vanishing from the dock mid-run.
 */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** One entry of the session plan — full-replacement semantics (ACP style). */
export interface PlanEntry {
  content: string;
  status: PlanStatus;
  priority?: 'high' | 'medium' | 'low';
  /** Present-continuous label shown while the entry is in progress
   *  (claude TodoWrite's `activeForm`). */
  activeForm?: string;
}

/**
 * Raw token counts — never pre-weighted (cost weighting is a presentation
 * concern, not a wire concern).
 *
 * Per backend: claude `result.usage` (+ `total_cost_usd` as `costUsd` on the
 * carrying event); codex `thread/tokenUsage/updated` (no USD); opencode
 * `message.updated` info.tokens/cost and `step-finish` parts.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** The backend's own total when given, else the sum of the parts. */
  total: number;
  /** Model context-window size when known — feeds the fill gauge. */
  contextWindow?: number;
}

/**
 * One file change carried by an edit-tool item.
 * claude `Edit`/`Write` input → `oldText`/`newText`; codex
 * `fileChange.changes[]` → `unified`; opencode `patch` parts → `unified`.
 * `oldText: null` means the file is newly created.
 */
export interface FileDiff {
  path: string;
  oldText: string | null;
  newText?: string;
  unified?: string;
}

/** A file location a tool touched (feeds "jump to file" affordances). */
export interface ToolLocation {
  path: string;
  line?: number;
}

/** A choice offered by a permission request (ACP option kinds). */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  id: string;
  label: string;
  kind: PermissionOptionKind;
}

/* ------------------------------------------------------------------ */
/* Items — ONE id-keyed stream for text, reasoning and tools           */
/* ------------------------------------------------------------------ */

/**
 * A chat message.
 * claude: `assistant` `text` blocks (whole-block, or true deltas via
 * `--include-partial-messages`); codex: `agentMessage` items (`phase` from
 * the item's own phase field); opencode: text parts of a message.
 */
export interface UiMessageItem {
  kind: 'message';
  id: string;
  role: 'assistant' | 'user';
  text: string;
  phase?: 'commentary' | 'final';
  parentItemId?: string;
}

/**
 * Extended thinking / reasoning summary.
 * claude: `thinking` blocks; codex: `reasoning` items (+ textDelta);
 * opencode: `reasoning` parts.
 */
export interface UiReasoningItem {
  kind: 'reasoning';
  id: string;
  text: string;
  parentItemId?: string;
}

/**
 * One tool invocation with its full lifecycle.
 * claude: `tool_use` (started, status `running`) + `tool_result`
 * (completed/failed; `permission_denials` → `declined`); codex: typed items
 * (`commandExecution`→execute with `exitCode`, `fileChange`→edit with
 * `diffs`, `mcpToolCall`→other, `webSearch`→fetch); opencode: tool parts
 * (state pending/running/completed/error, `patch` parts → `diffs`).
 *
 * `parentItemId` nests subagent work under its spawning task item —
 * claude `parent_tool_use_id`, opencode `subtask` parts, codex review items.
 */
export interface UiToolItem {
  kind: 'tool';
  id: string;
  /** The backend's tool name / item type (e.g. `Bash`, `commandExecution`). */
  name: string;
  /** ACP-style icon/verb hint — see `toolDisplay()` in `tool-display.ts`. */
  toolKind: ToolKind;
  /** Human line, computed once in the protocol layer: "Ran npm test". */
  title: string;
  status: ToolStatus;
  /** Raw input — may arrive incrementally. */
  input?: unknown;
  output?: string;
  error?: string;
  diffs?: FileDiff[];
  locations?: ToolLocation[];
  /** commandExecution / bash exit code, when the backend reports one. */
  exitCode?: number;
  parentItemId?: string;
}

export type UiItem = UiMessageItem | UiReasoningItem | UiToolItem;

/* ------------------------------------------------------------------ */
/* Events — discriminated on `type`                                    */
/* ------------------------------------------------------------------ */

/**
 * Session opened.
 * claude: `system/init` (model, tools, cwd); codex: `thread/started` or the
 * `thread/start` result; opencode: `POST /session` response.
 */
export interface UiSessionStartedEvent {
  type: 'session.started';
  sessionId: string;
  backend: UiBackend;
  model?: string;
  cwd?: string;
  tools?: string[];
}

/** Session over (replaces v1 `done` / fatal `error`). */
export interface UiSessionEndedEvent {
  type: 'session.ended';
  reason: StopReason;
  message?: string;
}

/** v1 `note` + `error` unified — severity explicit instead of implied. */
export interface UiSessionErrorEvent {
  type: 'session.error';
  message: string;
  fatal: boolean;
}

/**
 * A turn began.
 * claude: on each stdin user message; codex: `turn/started`;
 * opencode: on each prompt POST.
 */
export interface UiTurnStartedEvent {
  type: 'turn.started';
  turnId: string;
}

/**
 * A turn finished.
 * claude: `result` (usage + `total_cost_usd`); codex: `turn/completed` /
 * `turn/failed`; opencode: `session.idle`.
 */
export interface UiTurnCompletedEvent {
  type: 'turn.completed';
  turnId: string;
  stopReason: StopReason;
  usage?: TokenUsage;
  costUsd?: number;
}

/** An item entered the stream (tools usually with status pending/running). */
export interface UiItemStartedEvent {
  type: 'item.started';
  item: UiItem;
}

/**
 * Streaming append to one field of a live item.
 * claude: partial-message text deltas; codex: `item/agentMessage/delta`
 * (`text`), `item/reasoning/textDelta` (`reasoning`),
 * `item/commandExecution/outputDelta` (`output` — live terminal); opencode:
 * text/reasoning part cursor deltas, running-state metadata for `output`.
 * claude has no live command output — the tool card fills on completion
 * (per-capability degradation, never per-backend).
 */
export interface UiItemDeltaEvent {
  type: 'item.delta';
  itemId: string;
  field: 'text' | 'reasoning' | 'output';
  delta: string;
}

/** Status flips and streamed-content snapshots (codex `item/updated`,
 *  opencode part-state flips such as pending→running). */
export interface UiItemUpdatedEvent {
  type: 'item.updated';
  item: UiItem;
}

/** Final snapshot of an item — safe to persist (snapshots, not deltas). */
export interface UiItemCompletedEvent {
  type: 'item.completed';
  item: UiItem;
}

/**
 * Full-replacement plan snapshot (ACP semantics).
 * claude: `TodoWrite` tool input, or a snapshot folded from the incremental
 * `TaskCreate`/`TaskUpdate`/`TaskList` calls (keyed by the task id the harness
 * reports in each tool's RESULT — see `claude-ui-mapper`); codex: the
 * `turn/plan/updated` notification carrying the whole `update_plan` list (it is
 * a turn-level notification, NOT an item — the app-server `ThreadItem` union has
 * no todo variant); opencode: `todowrite` tool input — identical
 * full-replacement semantics across all three.
 */
export interface UiPlanUpdatedEvent {
  type: 'plan.updated';
  entries: PlanEntry[];
}

/**
 * RESERVED — wired when auto-approve becomes optional. Types only for now.
 * claude: `control_request can_use_tool`; codex: the per-item
 * `requestApproval` JSON-RPC requests; opencode: `permission.updated`.
 */
export interface UiPermissionRequestedEvent {
  type: 'permission.requested';
  requestId: string;
  itemId?: string;
  title: string;
  options: PermissionOption[];
}

/** RESERVED — the counterpart resolution (see `permission.requested`). */
export interface UiPermissionResolvedEvent {
  type: 'permission.resolved';
  requestId: string;
  optionId: string;
}

/** One option in an AskUser question — see `src/core/ask.ts`. */
export interface UiAskOption {
  label: string;
  description?: string;
}

/** One structured multiple-choice question — modeled on Claude Code's
 *  `AskUserQuestion` (see `src/core/ask.ts`). */
export interface UiAskQuestion {
  id?: string;
  header: string;
  question: string;
  options: UiAskOption[];
  multiSelect?: boolean;
}

/**
 * The agent asked the user a structured multiple-choice question via a
 * `CEZ:ASK` marker (spec `2026-07-18-askuser-across-runners`). Emitted by the
 * RunManager off the assembled turn text — uniform across claude/codex/opencode
 * with no per-backend mapper work. The run parks `waiting`; the cockpit renders
 * clickable option chips. Resolution is client-side — the next user message for
 * the run closes the card — so there is no separate `ask.resolved` event.
 */
export interface UiAskRequestedEvent {
  type: 'ask.requested';
  requestId: string;
  questions: UiAskQuestion[];
}

/**
 * Cumulative-for-session raw telemetry.
 * claude: `result.usage` + `total_cost_usd`; codex:
 * `thread/tokenUsage/updated` (cost stays absent); opencode:
 * `message.updated` tokens/cost + `step-finish` increments.
 */
export interface UiUsageUpdatedEvent {
  type: 'usage.updated';
  usage: TokenUsage;
  costUsd?: number;
}

/**
 * An image emitted mid-stream (kept from v1) — raw base64 on the wire here;
 * the run manager persists it and re-emits a URL. claude: image blocks in
 * `tool_result` (with `itemId` linking back to the tool item).
 */
export interface UiImageEvent {
  type: 'image';
  itemId?: string;
  mediaType: string;
  data: string;
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
  | UiImageEvent;

/** Every v2 event discriminator — `satisfies Record<UiEventType, …>` maps
 *  downstream keep new event types honest at compile time. */
export type UiEventType = UiEvent['type'];

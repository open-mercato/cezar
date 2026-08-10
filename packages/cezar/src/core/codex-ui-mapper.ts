/**
 * Pure codex app-server JSON-RPC → protocol-v2 mapper. `mapCodexNotification`
 * folds one parsed JSONL frame into `UiEvent`s plus the next mapper state;
 * the runner calls it ALONGSIDE the v1 path (v1 events keep flowing
 * unchanged).
 *
 * Contract: `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §3
 * (wire format) and §7.1 "Codex (app-server)" (the mapping). Golden fixtures
 * replaying wire-faithful frame sequences live in `__fixtures__/codex/`.
 *
 * Robustness rule: input is untrusted wire data — the mapper never throws;
 * responses, server→client requests (handled by the session transport) and
 * unknown methods map to zero events.
 *
 * State is explicit and treated as immutable: callers thread the returned
 * `state` into the next call. Ids are deterministic — codex items and turns
 * carry stable wire ids which are reused verbatim (`turn_<n>` is minted only
 * when a turn frame arrives without one) — so replaying a stored transcript
 * reproduces the exact event sequence.
 *
 * Status map (§7.1, kills v1's regex-on-status hack): `inProgress→running`,
 * `completed→completed`, `failed→failed`, `declined→declined`.
 */

import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  StopReason,
  TokenUsage,
  ToolLocation,
  ToolStatus,
  UiEvent,
  UiItem,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

/** The two reasoning delta channels, accumulated separately — see
 *  `CodexUiMapperState.reasonings`. */
export interface ReasoningAccumulator {
  /** `item/reasoning/textDelta` — the raw chain of thought. */
  readonly text: string;
  /** `item/reasoning/summaryDelta` + `summaryTextDelta` — the condensed summary. */
  readonly summary: string;
}

interface CodexCollabTask {
  readonly itemId: string;
  readonly prompt?: string;
  readonly model?: string;
}

export interface CodexUiMapperState {
  /** True once `session.started` was emitted (thread/started notification or
   *  the runner's `codexSessionStarted` after the thread/start result —
   *  whichever lands first wins; the other is deduplicated). */
  readonly sessionStarted: boolean;
  /** Fallback counter for turn frames that arrive without a wire turn id. */
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  /** Fresh `tokenUsage.last` received while the current turn is active.
   * Consumed exactly once by its matching turn end; cumulative `total` is
   * never used as a persisted per-turn delta. */
  readonly pendingTurnUsage: TokenUsage | null;
  /** Item ids already introduced — a delta for an unknown id synthesizes an
   *  `item.started` first so consumers always have something to upsert. */
  readonly knownItems: ReadonlySet<string>;
  /** Accumulated `outputDelta` text per commandExecution item, attached to
   *  the final snapshot when the wire `item/completed` carries no output. */
  readonly outputs: ReadonlyMap<string, string>;
  /** Accumulated reasoning deltas per reasoning item, attached to the final
   *  snapshot when the wire `item/completed` carries no `content`. Deltas are
   *  live-only (never persisted), so without this the reasoning text is
   *  unrecoverable on replay and the row reads back empty (#528).
   *
   *  Kept PER CHANNEL: `item/reasoning/textDelta` streams the raw chain of
   *  thought while `summaryDelta`/`summaryTextDelta` stream the condensed
   *  summary, and codex emits both when raw reasoning is enabled. One shared
   *  bucket would concatenate the two into `"<raw CoT><summary>"` and persist
   *  that garble over the clean wire `summary`.
   *
   *  Turn-scoped, and reset by `turn/started`: an interrupted item is never
   *  completed, so without the reset its text would both leak into a later
   *  turn that reuses the id and pin whole chains of thought in memory. */
  readonly reasonings: ReadonlyMap<string, ReasoningAccumulator>;
  /** True once `turn/plan/updated` has spoken IN THE CURRENT TURN. Both that
   *  notification and the `plan`/`todoList` item arm write `plan.updated`, so
   *  without a precedence rule the last frame wins and a prose plan item would
   *  flatten the real checklist into one entry. The authoritative channel
   *  latches this and the item arm stands down (see `mapItemLifecycle`).
   *
   *  Turn-scoped, and reset by `turn/started`: a plan belongs to a turn (hence
   *  `turn/plan/updated`), so a latch that outlived its turn would gag the item
   *  arm for the rest of the session and strand the dock on a stale checklist. */
  readonly planFromNotification: boolean;
  /** The open review-mode item's id, or `null` when review mode is not active.
   *
   *  Codex announces review mode as two disjoint frames (`enteredReviewMode`,
   *  `exitedReviewMode`) with different ids. Mapped literally that is two
   *  childless `task` items — which the Agents dock would read as two separate
   *  sub-agents that each did nothing (spec
   *  `.ai/specs/2026-07-20-grouped-subagent-display.md` §"Codex-mapper fix",
   *  #474). This latch folds the pair into ONE item with a running→completed
   *  lifecycle: the entered frame opens it, the exited frame completes that
   *  same id. An unpaired exit falls back to its own item, so a stream that
   *  starts mid-review still renders. */
  readonly reviewItemId: string | null;
  /** Child thread → stable task item created by a Codex collaboration spawn.
   * Installed 0.144.6 uses `collabAgentToolCall`; newer protocol revisions use
   * `collabToolCall`. Both carry the receiver ids used for child attribution. */
  readonly collabTasks: ReadonlyMap<string, CodexCollabTask>;
}

export interface CodexUiMapping {
  events: UiEvent[];
  state: CodexUiMapperState;
}

export function createCodexUiState(): CodexUiMapperState {
  return {
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    pendingTurnUsage: null,
    knownItems: new Set(),
    outputs: new Map(),
    reasonings: new Map(),
    planFromNotification: false,
    reviewItemId: null,
    collabTasks: new Map(),
  };
}

/**
 * Codex confirms the thread via the `thread/start`/`thread/resume` RESULT
 * (a response frame the mapper cannot attribute), so the runner calls this
 * once the thread id is known. Deduplicated against the `thread/started`
 * notification — whichever arrives first emits `session.started`.
 */
export function codexSessionStarted(threadId: string, state: CodexUiMapperState): CodexUiMapping {
  if (state.sessionStarted || threadId === '') return { events: [], state };
  return {
    events: [{ type: 'session.started', sessionId: threadId, backend: 'codex' }],
    state: { ...state, sessionStarted: true },
  };
}

/** Fold one parsed JSON-RPC frame into v2 events. Never throws. */
export function mapCodexNotification(frame: unknown, state: CodexUiMapperState): CodexUiMapping {
  if (!isRecord(frame) || typeof frame.method !== 'string') return { events: [], state };
  // Server requests are answered by CodexSession, not the notification mapper.
  if (frame.id !== undefined) return { events: [], state };
  const params = isRecord(frame.params) ? frame.params : {};
  switch (frame.method) {
    case 'thread/started':
      return codexSessionStarted(threadIdOf(params) ?? '', state);
    case 'turn/started':
      return mapTurnStarted(params, state);
    case 'turn/completed':
      return mapTurnEnd(params, state, /* failed */ false);
    case 'turn/failed':
      return mapTurnEnd(params, state, /* failed */ true);
    case 'turn/plan/updated':
      return mapTurnPlanUpdated(params, state);
    case 'item/started':
      return mapItemLifecycle(params, state, 'item.started');
    case 'item/updated':
      return mapItemLifecycle(params, state, 'item.updated');
    case 'item/completed':
      return mapItemLifecycle(params, state, 'item.completed');
    case 'item/agentMessage/delta':
      return mapDelta(params, state, 'text');
    case 'item/reasoning/textDelta':
      return mapDelta(params, state, 'reasoning', 'text');
    case 'item/reasoning/summaryDelta':
    case 'item/reasoning/summaryTextDelta':
      return mapDelta(params, state, 'reasoning', 'summary');
    case 'item/commandExecution/outputDelta':
      return mapDelta(params, state, 'output');
    case 'thread/tokenUsage/updated':
      return mapTokenUsage(params, state);
    default:
      // thread/status/changed, thread/closed, … — nothing to render yet.
      return { events: [], state };
  }
}

// ---- turn lifecycle ---------------------------------------------------------

function mapTurnStarted(params: Record<string, unknown>, state: CodexUiMapperState): CodexUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = turnIdOf(params) ?? `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    // planFromNotification is turn-scoped — a new turn re-opens the item arm.
    // So are the reasoning accumulators: an interrupted item never completes,
    // so its text would otherwise leak into a later turn that reuses the id
    // and pin whole chains of thought in memory for the session (#528).
    state: {
      ...state,
      turnSeq,
      currentTurnId: turnId,
      pendingTurnUsage: null,
      planFromNotification: false,
      reasonings: new Map(),
    },
  };
}

function mapTurnEnd(
  params: Record<string, unknown>,
  state: CodexUiMapperState,
  failed: boolean,
): CodexUiMapping {
  let turnSeq = state.turnSeq;
  const turnId = turnIdOf(params) ?? state.currentTurnId ?? `turn_${++turnSeq}`;
  const closesActiveTurn = state.currentTurnId === null || turnId === state.currentTurnId;
  // A review span still open when the turn ends never gets its `exitedReviewMode` — an
  // interrupted, cancelled or failed turn simply stops. Close it here, or the item stays
  // `running` forever and the Agents dock reads a finished run as a live fan-out (#474).
  // The status follows the turn: a turn that failed did not complete its review.
  const events: UiEvent[] = [];
  if (closesActiveTurn && state.reviewItemId !== null) {
    events.push({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: state.reviewItemId,
        name: 'enteredReviewMode',
        toolKind: 'task',
        title: 'Review',
        status: failed ? 'failed' : 'completed',
      },
    });
  }
  const completed: Extract<UiEvent, { type: 'turn.completed' }> = {
    type: 'turn.completed',
    turnId,
    stopReason: turnStopReason(params, failed),
  };
  if (turnId === state.currentTurnId && state.pendingTurnUsage !== null) {
    completed.usage = state.pendingTurnUsage;
  }
  events.push(completed);
  return {
    events,
    state: closesActiveTurn
      ? { ...state, turnSeq, currentTurnId: null, pendingTurnUsage: null, reviewItemId: null }
      : { ...state, turnSeq },
  };
}

/** §7.1: turn/completed→end_turn, turn/failed→error — except an interrupted
 *  turn (turn.status `interrupted`, or an interrupt-shaped error message,
 *  the only wire signals codex gives us) → cancelled. */
function turnStopReason(params: Record<string, unknown>, failed: boolean): StopReason {
  const turn = isRecord(params.turn) ? params.turn : {};
  if (turn.status === 'interrupted') return 'cancelled';
  if (!failed) return 'end_turn';
  return /interrupt/i.test(errorMessage(params.error) ?? '') ? 'cancelled' : 'error';
}

// ---- plan -------------------------------------------------------------------

/**
 * `turn/plan/updated` → the plan dock. This is the ONLY channel codex's
 * `update_plan` tool reaches the client on: the app-server `ThreadItem` union
 * has no todo/`todoList` variant, so the plan is a turn-level notification
 * rather than an item (verified against
 * `app-server-protocol/schema/typescript/v2/TurnPlanUpdatedNotification.ts`).
 *
 * Full replacement: `plan` carries the entire list on every notification and
 * the steps have no wire ids, so the snapshot IS the plan — no accumulation
 * (contrast the claude mapper's id-keyed TaskCreate/TaskUpdate fold).
 *
 * `explanation` (the model's prose rationale) is deliberately dropped: the dock
 * renders entries only, and PlanEntry has nowhere to put it.
 */
function mapTurnPlanUpdated(params: Record<string, unknown>, state: CodexUiMapperState): CodexUiMapping {
  const entries = turnPlanEntries(params.plan);
  if (!entries) return { events: [], state };
  return {
    events: [{ type: 'plan.updated', entries }],
    state: state.planFromNotification ? state : { ...state, planFromNotification: true },
  };
}

/** `plan: [{step, status}]` → plan entries. An EMPTY array is a legitimate
 *  snapshot (the agent cleared its plan) and clears the dock; anything else that
 *  yields no entries — a non-array, or rows we could not read a step out of —
 *  is malformed and maps to zero events, so a garbled frame cannot wipe a good
 *  plan. The distinction matters: "the agent has no steps" and "we failed to
 *  parse the steps" look identical downstream once they are both `[]`. */
function turnPlanEntries(plan: unknown): PlanEntry[] | undefined {
  if (!Array.isArray(plan)) return undefined;
  const entries: PlanEntry[] = [];
  for (const step of plan) {
    if (!isRecord(step)) continue;
    const content = str(step.step);
    if (content === undefined) continue;
    entries.push({ content, status: turnPlanStatus(step.status) });
  }
  if (plan.length > 0 && entries.length === 0) return undefined;
  return entries;
}

/** `TurnPlanStepStatus` is camelCase ON THE APP-SERVER WIRE (`inProgress`) even
 *  though codex's core protocol type is snake_case — the app-server layer
 *  re-serializes. Accept both spellings rather than depend on that detail, and
 *  treat anything unknown as `pending` (a step the agent has not reached). */
function turnPlanStatus(status: unknown): PlanStatus {
  if (status === 'completed') return 'completed';
  if (status === 'inProgress' || status === 'in_progress') return 'in_progress';
  return 'pending';
}

// ---- item lifecycle ---------------------------------------------------------

type ItemEventType = 'item.started' | 'item.updated' | 'item.completed';

function mapItemLifecycle(
  params: Record<string, unknown>,
  state: CodexUiMapperState,
  eventType: ItemEventType,
): CodexUiMapping {
  const raw = isRecord(params.item) ? params.item : undefined;
  if (!raw || typeof raw.type !== 'string') return { events: [], state };
  const type = raw.type;

  // `plan` / `todoList` items never render as items — they ARE the plan
  // (full-replacement semantics on every lifecycle phase, §7.1).
  //
  // `plan` is the plan-MODE item (`{type:'plan', id, text}`, streamed via
  // `item/plan/delta`) — prose, not a checklist, and mutually exclusive with
  // `update_plan` (codex rejects that tool in plan mode). It becomes the single
  // entry the agent is executing.
  //
  // `todoList` is NOT an app-server item type — the v2 `ThreadItem` union has no
  // todo variant, so this arm is dead on the transport cezar spawns. It is kept
  // as cheap tolerance: these types are marked EXPERIMENTAL upstream, codex's
  // exec transport does emit a `todo_list` item, and a stray snapshot is better
  // rendered than dropped. The real plan channel is `turn/plan/updated`.
  //
  // That makes this the SECOND writer of `plan.updated`, so it yields to the
  // first: once the notification has delivered a real checklist, a prose `plan`
  // item must not flatten it back into a single entry. Upstream says the two are
  // mutually exclusive (codex rejects `update_plan` in plan mode) — this does not
  // depend on that holding.
  if (type === 'todoList' || type === 'todo_list' || type === 'plan') {
    if (state.planFromNotification) return { events: [], state };
    const entries = planEntriesOf(raw);
    if (!entries) return { events: [], state };
    return { events: [{ type: 'plan.updated', entries }], state };
  }

  // The user's own message echoed back — the client already rendered what it
  // sent, so it maps to zero events (matching the claude mapper).
  if (type === 'userMessage') return { events: [], state };

  const id = str(raw.id);
  if (id === undefined) return { events: [], state };

  // Review mode is a PAIR of frames describing one span of work — folded into a
  // single lifecycle before the generic arm, which knows only one frame at a time.
  if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
    return mapReviewMode(raw, id, type, eventType, state);
  }

  // Internal collaboration telemetry is not a user tool. Codex emits one
  // `subAgentActivity(kind: started)` when it creates a child thread, followed
  // by `interacted` bookkeeping as control returns between threads.
  if (type === 'subAgentActivity') return mapSubAgentActivity(raw, id, state);

  const item =
    type === 'agentMessage'
      ? messageItem(raw, id)
      : type === 'reasoning'
        ? reasoningItem(raw, id, state)
        : toolItem(raw, id, type, eventType, state);
  if (type === 'collabAgentToolCall' || type === 'collabToolCall') {
    return mapCollabToolCall(raw, id, eventType, state);
  }
  const parentItemId = collabParentItemId(params, state);
  if (parentItemId !== undefined) item.parentItemId = parentItemId;
  const events: UiEvent[] = [{ type: eventType, item }];

  // Track live ids (for delta synthesis) and drop bookkeeping on completion.
  if (eventType === 'item.completed') {
    if (!state.knownItems.has(id) && !state.outputs.has(id) && !state.reasonings.has(id)) {
      return { events, state };
    }
    const knownItems = new Set(state.knownItems);
    knownItems.delete(id);
    const outputs = new Map(state.outputs);
    outputs.delete(id);
    const reasonings = new Map(state.reasonings);
    reasonings.delete(id);
    return { events, state: { ...state, knownItems, outputs, reasonings } };
  }
  if (state.knownItems.has(id)) return { events, state };
  return { events, state: { ...state, knownItems: new Set(state.knownItems).add(id) } };
}

function mapSubAgentActivity(
  raw: Record<string, unknown>,
  id: string,
  state: CodexUiMapperState,
): CodexUiMapping {
  if (str(raw.kind) !== 'started' || state.knownItems.has(id)) return { events: [], state };
  const agentPath = str(raw.agentPath);
  const agentName = agentPath?.split('/').filter(Boolean).at(-1)?.replaceAll('_', ' ');
  const agentThreadId = str(raw.agentThreadId);
  const display = toolDisplay('Task', agentName ? { description: agentName } : undefined);
  const task: CodexCollabTask = { itemId: id, ...(agentName ? { prompt: agentName } : {}) };
  const collabTasks = new Map(state.collabTasks);
  if (agentThreadId) collabTasks.set(agentThreadId, task);
  return {
    events: [{
      type: 'item.started',
      item: {
        kind: 'tool', id, name: 'spawnAgent', toolKind: 'task', title: display.title, status: 'running',
        input: { ...(agentPath ? { agentPath } : {}), ...(agentThreadId ? { agentThreadId } : {}) },
      },
    }],
    state: { ...state, knownItems: new Set(state.knownItems).add(id), collabTasks },
  };
}

/** A spawn creates one task row; later send/wait/resume/close calls update the
 * same row through receiver-thread correlation instead of creating duplicates. */
function mapCollabToolCall(
  raw: Record<string, unknown>,
  id: string,
  eventType: ItemEventType,
  state: CodexUiMapperState,
): CodexUiMapping {
  const operation = str(raw.tool) ?? str(raw.operation);
  const receiverIds = stringArray(raw.receiverThreadIds ?? raw.receiver_thread_ids);
  const isSpawn = operation === 'spawnAgent' || operation === 'spawn_agent';
  if (isSpawn) {
    const prompt = str(raw.prompt);
    const model = str(raw.model);
    const task: CodexCollabTask = { itemId: id, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}) };
    let collabTasks = state.collabTasks;
    if (receiverIds.length > 0) {
      const next = new Map(state.collabTasks);
      for (const threadId of receiverIds) next.set(threadId, task);
      collabTasks = next;
    }
    const status = collabStatus(raw, receiverIds, eventType);
    const mappedType: ItemEventType = eventType === 'item.started'
      ? eventType
      : status === 'running' || status === 'pending' ? 'item.updated' : 'item.completed';
    return {
      events: [{ type: mappedType, item: collabTaskItem(task, status) }],
      state: { ...state, collabTasks },
    };
  }

  const tasks = new Map<string, CodexCollabTask>();
  for (const threadId of receiverIds) {
    const task = state.collabTasks.get(threadId);
    if (task) tasks.set(task.itemId, task);
  }
  if (tasks.size === 0) return { events: [], state };
  const status = collabStatus(raw, receiverIds, eventType);
  const mappedType: ItemEventType = status === 'running' || status === 'pending' ? 'item.updated' : 'item.completed';
  return {
    events: [...tasks.values()].map((task) => ({ type: mappedType, item: collabTaskItem(task, status) })),
    state,
  };
}

function collabTaskItem(task: CodexCollabTask, status: ToolStatus): UiToolItem {
  const display = toolDisplay('Task', task.prompt ? { description: task.prompt } : undefined);
  const input: Record<string, unknown> = {};
  if (task.prompt) input.prompt = task.prompt;
  if (task.model) input.model = task.model;
  return {
    kind: 'tool', id: task.itemId, name: 'spawnAgent', toolKind: 'task', title: display.title, status,
    ...(Object.keys(input).length > 0 ? { input } : {}),
  };
}

function collabStatus(raw: Record<string, unknown>, receiverIds: string[], eventType: ItemEventType): ToolStatus {
  const states = isRecord(raw.agentsStates) ? raw.agentsStates
    : isRecord(raw.agents_states) ? raw.agents_states : undefined;
  const statuses = receiverIds
    .map((threadId) => (states && isRecord(states[threadId]) ? states[threadId].status : undefined))
    .filter((status): status is string => typeof status === 'string');
  if (statuses.some((status) => status === 'errored' || status === 'notFound' || status === 'not_found')) return 'failed';
  if (statuses.some((status) => status === 'interrupted')) return 'declined';
  if (statuses.length > 0 && statuses.every((status) => status === 'completed' || status === 'shutdown')) return 'completed';
  if (statuses.some((status) => status === 'running' || status === 'pendingInit' || status === 'pending_init')) return 'running';
  return toolStatus(raw, eventType);
}

function collabParentItemId(params: Record<string, unknown>, state: CodexUiMapperState): string | undefined {
  const threadId = threadIdOf(params);
  return threadId ? state.collabTasks.get(threadId)?.itemId : undefined;
}

/**
 * §7.1: review-mode items → tool(kind task) — but ONE item for the pair, not two.
 *
 * `enteredReviewMode` opens the item (`running`); `exitedReviewMode` completes
 * **that same id**, so the cockpit sees one "Review" span with a lifecycle instead
 * of two childless task items that would read as two sub-agents (spec
 * `.ai/specs/2026-07-20-grouped-subagent-display.md` §"Codex-mapper fix", #474).
 *
 * The fallback matters: an exit with no open item — a resumed thread, a replay that
 * starts mid-review — still maps to its own completed item, so no frame is dropped.
 */
function mapReviewMode(
  raw: Record<string, unknown>,
  id: string,
  type: 'enteredReviewMode' | 'exitedReviewMode',
  eventType: ItemEventType,
  state: CodexUiMapperState,
): CodexUiMapping {
  const reviewItem = (itemId: string, name: string, status: ToolStatus): UiToolItem => ({
    kind: 'tool',
    id: itemId,
    name,
    toolKind: 'task',
    // One stable title across the lifecycle: the row must not rename itself on exit.
    title: 'Review',
    status,
  });

  if (type === 'enteredReviewMode') {
    const status = toolStatus(raw, eventType);
    const events: UiEvent[] = [];
    // A second entered frame with no intervening exit displaces the open span. Settle the
    // displaced item rather than leaking a permanently `running` row — the same rule the
    // opencode mapper's subtask slot follows.
    if (state.reviewItemId !== null && state.reviewItemId !== id) {
      events.push({
        type: 'item.completed',
        item: reviewItem(state.reviewItemId, 'enteredReviewMode', 'completed'),
      });
    }
    events.push({ type: eventType, item: reviewItem(id, type, status) });
    // Latch on the RESOLVED status, not the event phase: an entered frame that already
    // carries a terminal wire status closes the span whichever lifecycle phase it arrived in,
    // and one that is still in progress stays open even on an `item/completed` frame.
    const settled = status !== 'running' && status !== 'pending';
    return { events, state: { ...state, reviewItemId: settled ? null : id } };
  }

  const openId = state.reviewItemId;
  if (openId === null) {
    // Unpaired exit — today's shape, under the exit frame's own id.
    return {
      events: [{ type: 'item.completed', item: reviewItem(id, type, toolStatus(raw, 'item.completed')) }],
      state,
    };
  }
  return {
    events: [
      {
        type: 'item.completed',
        // The item was introduced by the entered frame, so it keeps that identity.
        item: reviewItem(openId, 'enteredReviewMode', toolStatus(raw, 'item.completed')),
      },
    ],
    state: { ...state, reviewItemId: null },
  };
}

/** `agentMessage` → message item; `phase` commentary|final_answer→'commentary'|'final'. */
function messageItem(raw: Record<string, unknown>, id: string): UiMessageItem {
  const item: UiMessageItem = {
    kind: 'message',
    id,
    role: 'assistant',
    text: typeof raw.text === 'string' ? raw.text : '',
  };
  if (raw.phase === 'commentary') item.phase = 'commentary';
  else if (raw.phase === 'final_answer') item.phase = 'final';
  return item;
}

/** `reasoning` → reasoning item. Precedence, most authoritative first:
 *  wire `content` → streamed raw chain of thought → the fuller of the wire
 *  `summary` and the streamed summary.
 *
 *  The accumulators matter on `item.completed`: deltas never reach disk, so a
 *  completed snapshot without `content` would otherwise persist the short
 *  summary (or nothing) and the row would read back empty after a reload
 *  (#528). They are consulted on `item.started` too — a delta can outrun its
 *  `item/started`, and re-emitting an empty snapshot would blank the row the
 *  synthesized item already filled.
 *
 *  Summary picks the LONGER of the two sources rather than preferring the
 *  stream: a mapper attached mid-turn, or any dropped frame, leaves a partial
 *  accumulator that must not overwrite a complete `summary` from the wire. */
function reasoningItem(
  raw: Record<string, unknown>,
  id: string,
  state: CodexUiMapperState,
): UiReasoningItem {
  const streamed = state.reasonings.get(id);
  // app-server v2 snapshots use arrays for both fields. Deltas remain scalar
  // strings, and older recorded transcripts may still contain scalar snapshots,
  // so accept both without weakening the untrusted-wire boundary.
  const summary = longer(reasoningSnapshotText(raw.summary), str(streamed?.summary));
  return {
    kind: 'reasoning',
    id,
    text: reasoningSnapshotText(raw.content) ?? str(streamed?.text) ?? summary ?? '',
  };
}

/** Join app-server reasoning parts without flattening their boundaries. Scalar
 *  strings remain accepted for replay compatibility with older transcripts. */
function reasoningSnapshotText(value: unknown): string | undefined {
  if (typeof value === 'string') return str(value);
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** The longer of two optional strings — neither present yields undefined. */
function longer(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.length > a.length ? b : a;
}

/** The §7.1 status map — the wire word wins; an item without one derives its
 *  status from the lifecycle phase it arrived in. */
const STATUS_MAP: Readonly<Record<string, ToolStatus>> = {
  inProgress: 'running',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
  declined: 'declined',
};

function toolStatus(raw: Record<string, unknown>, eventType: ItemEventType): ToolStatus {
  const mapped = typeof raw.status === 'string' ? STATUS_MAP[raw.status] : undefined;
  return mapped ?? (eventType === 'item.completed' ? 'completed' : 'running');
}

function toolItem(
  raw: Record<string, unknown>,
  id: string,
  type: string,
  eventType: ItemEventType,
  state: CodexUiMapperState,
): UiToolItem {
  const status = toolStatus(raw, eventType);
  let item: UiToolItem;

  switch (type) {
    case 'commandExecution': {
      const display = toolDisplay('commandExecution', raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status };
      if (raw.command !== undefined) item.input = { command: raw.command };
      // Wire output wins; else the final snapshot carries what outputDelta streamed.
      const output =
        str(raw.aggregatedOutput) ??
        str(raw.output) ??
        (eventType === 'item.completed' ? state.outputs.get(id) : undefined);
      if (output !== undefined) item.output = output;
      const exitCode = num(raw.exitCode);
      if (exitCode !== undefined) item.exitCode = exitCode;
      break;
    }
    case 'fileChange': {
      const display = toolDisplay('fileChange', raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status };
      const artifacts = changeArtifacts(raw.changes);
      if (artifacts) {
        item.diffs = artifacts.diffs;
        item.locations = artifacts.locations;
      }
      break;
    }
    case 'mcpToolCall': {
      const server = str(raw.server);
      const tool = str(raw.tool);
      const display = toolDisplay('mcpToolCall', raw);
      item = {
        kind: 'tool',
        id,
        // §7.1: the item is named after what it called, `server.tool`.
        name: server && tool ? `${server}.${tool}` : type,
        toolKind: display.toolKind,
        title: display.title,
        status,
      };
      if (raw.arguments !== undefined) item.input = raw.arguments;
      const result = raw.result;
      if (typeof result === 'string') item.output = result;
      else if (result !== undefined) item.output = safeStringify(result);
      break;
    }
    case 'webSearch': {
      const display = toolDisplay('webSearch', raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status };
      break;
    }
    default: {
      // Unknown item types stay visible as generic tool cards (v1 parity —
      // a future codex tool must not silently vanish from the thread).
      const display = toolDisplay(type, raw);
      item = { kind: 'tool', id, name: type, toolKind: display.toolKind, title: display.title, status, input: raw };
    }
  }

  const error = errorMessage(raw.error);
  if (error !== undefined) item.error = error;
  return item;
}

/** `fileChange.changes[]` `{path, kind, diff}` → `diffs[]` (unified) + locations. */
function changeArtifacts(changes: unknown): { diffs: FileDiff[]; locations: ToolLocation[] } | undefined {
  if (!Array.isArray(changes)) return undefined;
  const diffs: FileDiff[] = [];
  const locations: ToolLocation[] = [];
  for (const change of changes) {
    if (!isRecord(change) || typeof change.path !== 'string' || change.path === '') continue;
    // Codex sends unified diffs only — the old text is unknown, not "empty".
    const diff: FileDiff = { path: change.path, oldText: null };
    const unified = str(change.diff);
    if (unified !== undefined) diff.unified = unified;
    diffs.push(diff);
    locations.push({ path: change.path });
  }
  if (diffs.length === 0) return undefined;
  return { diffs, locations };
}

/** `todoList` items `{text, completed}` (and plan step arrays) → plan entries;
 *  a text-only `plan` item becomes the single entry the agent is executing. */
function planEntriesOf(raw: Record<string, unknown>): PlanEntry[] | undefined {
  const list = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.plan) ? raw.plan : undefined;
  if (list) {
    const entries: PlanEntry[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const content = str(entry.text) ?? str(entry.step) ?? str(entry.content);
      if (content === undefined) continue;
      if (typeof entry.completed === 'boolean') {
        entries.push({ content, status: entry.completed ? 'completed' : 'pending' });
      } else if (entry.status === 'pending' || entry.status === 'completed') {
        entries.push({ content, status: entry.status });
      } else if (entry.status === 'inProgress' || entry.status === 'in_progress') {
        entries.push({ content, status: 'in_progress' });
      } else {
        entries.push({ content, status: 'pending' });
      }
    }
    return entries;
  }
  const text = str(raw.text);
  if (text === undefined) return undefined;
  return [{ content: text, status: 'in_progress' }];
}

// ---- streaming deltas -------------------------------------------------------

/** Minimal item synthesized when a delta outruns its `item/started` — gives
 *  consumers a valid target to upsert; the completed snapshot reconciles. */
function synthesizedItem(itemId: string, field: 'text' | 'reasoning' | 'output'): UiItem {
  if (field === 'text') return { kind: 'message', id: itemId, role: 'assistant', text: '' };
  if (field === 'reasoning') return { kind: 'reasoning', id: itemId, text: '' };
  const display = toolDisplay('commandExecution');
  return { kind: 'tool', id: itemId, name: 'commandExecution', toolKind: display.toolKind, title: display.title, status: 'running' };
}

function mapDelta(
  params: Record<string, unknown>,
  state: CodexUiMapperState,
  field: 'text' | 'reasoning' | 'output',
  /** Which reasoning stream fed this delta — see `ReasoningAccumulator`. */
  reasoningChannel: 'text' | 'summary' = 'text',
): CodexUiMapping {
  const itemId = str(params.itemId);
  const delta = typeof params.delta === 'string' ? params.delta : '';
  if (itemId === undefined || delta === '') return { events: [], state };

  const events: UiEvent[] = [];
  let knownItems: ReadonlySet<string> = state.knownItems;
  if (!knownItems.has(itemId)) {
    const item = synthesizedItem(itemId, field);
    const parentItemId = collabParentItemId(params, state);
    if (parentItemId !== undefined) item.parentItemId = parentItemId;
    events.push({ type: 'item.started', item });
    knownItems = new Set(knownItems).add(itemId);
  }
  events.push({ type: 'item.delta', itemId, field, delta });

  let outputs: ReadonlyMap<string, string> = state.outputs;
  if (field === 'output') {
    const next = new Map(state.outputs);
    next.set(itemId, (next.get(itemId) ?? '') + delta);
    outputs = next;
  }
  let reasonings: ReadonlyMap<string, ReasoningAccumulator> = state.reasonings;
  if (field === 'reasoning') {
    const next = new Map(state.reasonings);
    const prev = next.get(itemId) ?? { text: '', summary: '' };
    next.set(
      itemId,
      reasoningChannel === 'text'
        ? { ...prev, text: prev.text + delta }
        : { ...prev, summary: prev.summary + delta },
    );
    reasonings = next;
  }
  return { events, state: { ...state, knownItems, outputs, reasonings } };
}

// ---- telemetry ---------------------------------------------------------------

/** `thread/tokenUsage/updated` → usage.updated. Raw CUMULATIVE totals from
 *  `tokenUsage.total`; codex reports no USD cost, so none is ever fabricated. */
function mapTokenUsage(params: Record<string, unknown>, state: CodexUiMapperState): CodexUiMapping {
  if (!isRecord(params.tokenUsage)) return { events: [], state };
  const tokenUsage = params.tokenUsage;
  const total = isRecord(tokenUsage.total) ? tokenUsage.total : undefined;
  if (!total) return { events: [], state };
  const usage = codexUsage(total);
  if (usage === undefined) return { events: [], state };
  const contextWindow = num(tokenUsage.modelContextWindow);
  if (contextWindow !== undefined) usage.contextWindow = contextWindow;
  const last = isRecord(tokenUsage.last) ? codexUsage(tokenUsage.last) : undefined;
  const nextState =
    state.currentTurnId !== null && last !== undefined ? { ...state, pendingTurnUsage: last } : state;
  return { events: [{ type: 'usage.updated', usage }], state: nextState };
}

function codexUsage(raw: Record<string, unknown>): TokenUsage | undefined {
  const input = nonNegative(raw.inputTokens);
  const output = nonNegative(raw.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const total = nonNegative(raw.totalTokens) ?? input + output;
  const usage: TokenUsage = { input, output, total };
  const cacheRead = nonNegative(raw.cachedInputTokens);
  const reasoning = nonNegative(raw.reasoningOutputTokens);
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

// ---- tiny guards --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = num(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

function turnIdOf(params: Record<string, unknown>): string | undefined {
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return (turn && str(turn.id)) ?? str(params.turnId);
}

function threadIdOf(params: Record<string, unknown>): string | undefined {
  const thread = isRecord(params.thread) ? params.thread : undefined;
  return (thread && str(thread.id)) ?? str(params.threadId);
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return str(error);
  if (isRecord(error)) return str(error.message);
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

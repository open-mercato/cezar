/**
 * Pure opencode SSE-bus → protocol-v2 mapper. `mapOpencodeEvent` folds one
 * parsed `{type, properties}` bus event into `UiEvent`s plus the next mapper
 * state; the runner calls it ALONGSIDE the v1 path (v1 events keep flowing
 * unchanged — including v1's HTTP-response-synthesized `turn-end`; only the
 * v2 stream uses the correct `session.idle` signal, fixing gap §5.9).
 *
 * Contract: `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §4
 * (wire format: Message/Part model, ToolState lifecycle) and §7.1
 * "OpenCode (SSE)" (the mapping). Golden fixtures replaying wire-faithful
 * bus-event sequences live in `__fixtures__/opencode/`.
 *
 * Robustness rule: input is untrusted wire data — the mapper never throws;
 * unknown event/part types map to zero events.
 *
 * State is explicit and treated as immutable: callers thread the returned
 * `state` into the next call. Ids are deterministic — items reuse the wire
 * part ids, turns get `turn_<n>` minted at each prompt POST — so replaying
 * a stored transcript reproduces the exact event sequence.
 *
 * Opencode-specific mechanics baked in:
 *  - text/reasoning parts carry the FULL accumulated text on every update;
 *    a per-part cursor diffs it into true `item.delta`s (a server-provided
 *    `delta` field wins when present — newer servers send it);
 *  - tool parts have the ONLY real `pending` phase of the three backends
 *    (`pending→pending`, `running→running`, `completed→completed`,
 *    `error→failed`);
 *  - the SSE bus is server-wide: parts from a foreign session id are the
 *    active subtask's child session and nest via `parentItemId` (§7.1);
 *    anything foreign outside a subtask scope is dropped.
 */

import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  TokenUsage,
  ToolLocation,
  ToolStatus,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
  UiUsageUpdatedEvent,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

/** Per-message telemetry: `message.updated` snapshots (cumulative per
 *  message) and summed `step-finish` increments are tracked separately —
 *  they describe the same accumulation, so the larger total wins and
 *  nothing is double-counted. */
interface MessageUsage {
  readonly info: TokenUsage | null;
  readonly infoCost: number | null;
  readonly steps: TokenUsage | null;
  readonly stepsCost: number | null;
}

interface SubtaskScope {
  readonly id: string;
  readonly title: string;
  readonly input?: unknown;
}

export interface OpencodeUiMapperState {
  /** The main session id (from POST /session) — the SSE bus is server-wide,
   *  so this is what separates our events from a subtask's child session. */
  readonly sessionId: string | null;
  /** True once `opencodeSessionStarted` emitted `session.started`. */
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  /** Message ids observed during the active turn. Their latest snapshots are
   * summed once when the matching `session.idle` closes the turn. */
  readonly currentTurnMessageIds: ReadonlySet<string>;
  /** A `session.error` arrived since the turn started → `session.idle`
   *  closes the turn with stopReason 'error' (§7.1). */
  readonly turnErrored: boolean;
  /** messageID → role. Parts carry no role; only assistant parts surface
   *  (the user's own prompt streams as parts over the same feed). */
  readonly msgRoles: ReadonlyMap<string, string>;
  /** Text/reasoning part id → chars already emitted as deltas. */
  readonly cursors: ReadonlyMap<string, number>;
  /** Part ids whose `item.started` was emitted. */
  readonly startedItems: ReadonlySet<string>;
  /** Text/reasoning/patch part ids whose `item.completed` was emitted. */
  readonly endedItems: ReadonlySet<string>;
  /** Tool part id → last emitted status/title (flip + live-title detection). */
  readonly tools: ReadonlyMap<string, { status: ToolStatus; title: string }>;
  /** Serialized last plan — todowrite snapshots are idempotent, so identical
   *  replacements emit no duplicate `plan.updated`. */
  readonly lastPlanJson: string | null;
  /** Child session id → subtask scope. Foreign parts are attributed only to
   *  their own child session; that session's idle completes the scope. */
  readonly subtasks: ReadonlyMap<string, SubtaskScope>;
  /** Subtask parts do not carry the child session id. Bind one on the first
   *  foreign event only while attribution is unambiguous. */
  readonly unboundSubtasks: readonly SubtaskScope[];
  readonly usageByMessage: ReadonlyMap<string, MessageUsage>;
  /** Last emitted session totals — usage.updated fires only on change. */
  readonly lastUsage: { total: number; cost: number | null } | null;
}

export interface OpencodeUiMapping {
  events: UiEvent[];
  state: OpencodeUiMapperState;
}

export function createOpencodeUiState(): OpencodeUiMapperState {
  return {
    sessionId: null,
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    currentTurnMessageIds: new Set(),
    turnErrored: false,
    msgRoles: new Map(),
    cursors: new Map(),
    startedItems: new Set(),
    endedItems: new Set(),
    tools: new Map(),
    lastPlanJson: null,
    subtasks: new Map(),
    unboundSubtasks: [],
    usageByMessage: new Map(),
    lastUsage: null,
  };
}

/**
 * Opencode has no wire-level session-start event — the session is created by
 * the runner's `POST /session`, so the runner calls this once the response
 * carries the id (like codex's out-of-band thread/start result).
 */
export function opencodeSessionStarted(
  sessionId: string,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (state.sessionStarted || sessionId === '') return { events: [], state };
  return {
    events: [{ type: 'session.started', sessionId, backend: 'opencode' }],
    state: { ...state, sessionId, sessionStarted: true },
  };
}

/**
 * Opencode has no wire-level turn-start either — the runner POSTing a prompt
 * IS the turn boundary, so the runner calls this on each prompt POST. The
 * matching `turn.completed` comes from the wire `session.idle` (never from
 * the HTTP prompt response — that is v1's known fidelity gap).
 */
export function opencodeTurnStarted(state: OpencodeUiMapperState): OpencodeUiMapping {
  const turnId = `turn_${state.turnSeq + 1}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: {
      ...state,
      turnSeq: state.turnSeq + 1,
      currentTurnId: turnId,
      currentTurnMessageIds: new Set(),
      turnErrored: false,
    },
  };
}

/** Fold one parsed SSE bus event into v2 events. Never throws. */
export function mapOpencodeEvent(evt: unknown, state: OpencodeUiMapperState): OpencodeUiMapping {
  if (!isRecord(evt) || typeof evt.type !== 'string') return { events: [], state };
  const props = isRecord(evt.properties) ? evt.properties : {};
  switch (evt.type) {
    case 'message.updated':
    case 'message.created':
    case 'message.completed':
      return mapMessageInfo(props, state);
    case 'message.part.updated':
    case 'message.part.created':
      return mapPart(props, state);
    case 'session.idle':
      return mapIdle(props, state);
    case 'session.error':
      return mapSessionError(props, state);
    default:
      // server.connected, session.updated, message.part.removed,
      // permission.* (reserved for the permission.* events later), …
      return { events: [], state };
  }
}

// ---- message info → roles + usage.updated -----------------------------------

function mapMessageInfo(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const info = isRecord(props.info) ? props.info : props;
  const id = str(info.id);
  const role = str(info.role);
  let next = state;
  const messageSession = str(info.sessionID);
  const foreign = messageSession !== undefined && state.sessionId !== null && messageSession !== state.sessionId;
  if (foreign && messageSession !== undefined) {
    next = resolveSubtask(messageSession, next).state;
  }
  if (id !== undefined && role !== undefined && state.msgRoles.get(id) !== role) {
    const msgRoles = new Map(state.msgRoles);
    msgRoles.set(id, role);
    next = { ...next, msgRoles };
  }
  if (id !== undefined && role === 'assistant' && next.currentTurnId !== null && !next.currentTurnMessageIds.has(id)) {
    next = { ...next, currentTurnMessageIds: new Set(next.currentTurnMessageIds).add(id) };
  }
  // Telemetry rides only on assistant messages (cumulative per message).
  if (id !== undefined && role === 'assistant') {
    const usage = tokensToUsage(info.tokens);
    const cost = num(info.cost);
    if (usage || cost !== undefined) {
      const prev = next.usageByMessage.get(id) ?? EMPTY_MESSAGE_USAGE;
      const merged: MessageUsage = {
        // Monotonic guard: a stale/zero snapshot never shrinks the record.
        info: usage && (prev.info === null || usage.total >= prev.info.total) ? usage : prev.info,
        infoCost: maxCost(prev.infoCost, cost),
        steps: prev.steps,
        stepsCost: prev.stepsCost,
      };
      const usageByMessage = new Map(next.usageByMessage);
      usageByMessage.set(id, merged);
      return emitUsage({ ...next, usageByMessage });
    }
  }
  return { events: [], state: next };
}

// ---- parts -------------------------------------------------------------------

function mapPart(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const part = isRecord(props.part) ? props.part : props;
  const type = str(part.type);
  const messageID = str(part.messageID);
  const id = str(part.id) ?? messageID;
  if (type === undefined || id === undefined) return { events: [], state };

  // Foreign-session parts nest only under the subtask bound to that child
  // session. A newly seen child can claim the sole unbound subtask; with two
  // candidates attribution is ambiguous, so the event is dropped.
  const partSession = str(part.sessionID);
  const foreign = partSession !== undefined && state.sessionId !== null && partSession !== state.sessionId;
  const resolved = foreign && partSession !== undefined ? resolveSubtask(partSession, state) : undefined;
  if (foreign && resolved?.subtask === undefined) return { events: [], state };
  state = resolved?.state ?? state;
  const parentItemId = resolved?.subtask?.id;

  // Only assistant parts surface — the user's own prompt streams as parts
  // over the same feed. Role is known early (message.updated precedes its
  // parts); an unknown role means "not assistant yet" → skip.
  if (messageID !== undefined && state.msgRoles.get(messageID) !== 'assistant') {
    return { events: [], state };
  }

  switch (type) {
    case 'text':
      return mapTextLike(part, id, 'text', props.delta, parentItemId, state);
    case 'reasoning':
      return mapTextLike(part, id, 'reasoning', props.delta, parentItemId, state);
    case 'tool':
      return mapTool(part, id, parentItemId, state);
    case 'patch':
      return mapPatch(part, id, parentItemId, state);
    case 'subtask':
      return mapSubtask(part, id, state);
    case 'step-finish':
      return mapStepFinish(part, messageID, state);
    default:
      // file, snapshot, step-start, agent, retry, compaction, … — nothing to
      // render yet.
      return { events: [], state };
  }
}

/** Text/reasoning parts carry the FULL accumulated text each update — the
 *  cursor diffs it into true deltas; a server-sent `delta` wins when present.
 *  `time.end` marks the part finished → `item.completed` (once). */
function mapTextLike(
  part: Record<string, unknown>,
  id: string,
  field: 'text' | 'reasoning',
  serverDelta: unknown,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  const full = typeof part.text === 'string' ? part.text : '';
  const events: UiEvent[] = [];
  let startedItems: ReadonlySet<string> = state.startedItems;
  let cursors: ReadonlyMap<string, number> = state.cursors;
  let endedItems: ReadonlySet<string> = state.endedItems;

  const makeItem = (text: string): UiMessageItem | UiReasoningItem => {
    const item: UiMessageItem | UiReasoningItem =
      field === 'text'
        ? { kind: 'message', id, role: 'assistant', text }
        : { kind: 'reasoning', id, text };
    if (parentItemId !== undefined) item.parentItemId = parentItemId;
    return item;
  };

  if (!startedItems.has(id)) {
    events.push({ type: 'item.started', item: makeItem('') });
    startedItems = new Set(startedItems).add(id);
  }

  const cursor = cursors.get(id) ?? 0;
  const winning = str(serverDelta);
  let delta: string | undefined;
  let nextCursor = cursor;
  if (winning !== undefined) {
    delta = winning;
    // Keep the cursor consistent with the accumulated text so a later
    // full-text-only update doesn't re-emit what the server delta covered.
    nextCursor = Math.max(cursor + winning.length, full.length);
  } else if (full.length > cursor) {
    delta = full.slice(cursor);
    nextCursor = full.length;
  }
  if (delta !== undefined) {
    events.push({ type: 'item.delta', itemId: id, field, delta });
    const nextCursors = new Map(cursors);
    nextCursors.set(id, nextCursor);
    cursors = nextCursors;
  }

  const time = isRecord(part.time) ? part.time : undefined;
  if (time && num(time.end) !== undefined && !endedItems.has(id)) {
    events.push({ type: 'item.completed', item: makeItem(full) });
    endedItems = new Set(endedItems).add(id);
  }

  if (events.length === 0) return { events, state };
  return { events, state: { ...state, startedItems, cursors, endedItems } };
}

/** The §7.1 direct status map — opencode is the only backend with a real
 *  pending phase, and its `error` state is v2's `failed`. */
const STATUS_MAP: Readonly<Record<string, ToolStatus>> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  error: 'failed',
};

function mapTool(
  part: Record<string, unknown>,
  id: string,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  const name = str(part.tool) ?? str(part.name) ?? 'tool';
  const toolState = isRecord(part.state) ? part.state : {};
  const prev = state.tools.get(id);
  const mapped = typeof toolState.status === 'string' ? STATUS_MAP[toolState.status] : undefined;
  const status: ToolStatus = mapped ?? prev?.status ?? 'pending';

  const display = toolDisplay(name, toolState.input);
  // The running/completed states carry a live human title ("npm test") — the
  // wire word wins over the derived one (§7.1). The error state has no title
  // field (§4.2), so the last live title carries over instead of regressing.
  const title = str(toolState.title) ?? prev?.title ?? display.title;

  const item: UiToolItem = { kind: 'tool', id, name, toolKind: display.toolKind, title, status };
  if (toolState.input !== undefined) item.input = toolState.input;
  if (status === 'completed') {
    const output = str(toolState.output);
    if (output !== undefined) item.output = output;
  }
  if (status === 'failed') {
    const error = errorText(toolState.error);
    if (error !== undefined) item.error = error;
  }
  const metadata = isRecord(toolState.metadata) ? toolState.metadata : undefined;
  const exitCode = metadata ? num(metadata.exit) : undefined;
  if (exitCode !== undefined) item.exitCode = exitCode;
  if (parentItemId !== undefined) item.parentItemId = parentItemId;

  const events: UiEvent[] = [];
  const settled = status === 'completed' || status === 'failed';
  if (prev === undefined) {
    // First sight — a part already settled is a lone final snapshot
    // (consumers upsert by id, so it renders fine).
    events.push({ type: settled ? 'item.completed' : 'item.started', item });
  } else if (prev.status !== status) {
    events.push({ type: settled ? 'item.completed' : 'item.updated', item });
  } else if (prev.title !== title && !settled) {
    // Same state, new live title (running-state metadata updates).
    events.push({ type: 'item.updated', item });
  }

  let next = state;
  if (events.length > 0) {
    const tools = new Map(state.tools);
    tools.set(id, { status, title });
    next = { ...next, tools };
  }

  // todowrite IS the plan (full-replacement semantics, deduplicated).
  if (name.toLowerCase() === 'todowrite') {
    const entries = planEntriesOf(toolState.input);
    if (entries) {
      const json = JSON.stringify(entries);
      if (json !== next.lastPlanJson) {
        events.push({ type: 'plan.updated', entries });
        next = { ...next, lastPlanJson: json };
      }
    }
  }

  if (events.length === 0 && next === state) return { events, state };
  return { events, state: next };
}

/**
 * todowrite input `{todos:[{content,status,priority}]}` → plan entries
 * (an empty list is a valid plan; malformed rows are filtered).
 *
 * `status` is a free-form string upstream (`Schema.String`, not an enum) — its
 * documented vocabulary is pending|in_progress|completed|cancelled. Rows with
 * an unrecognized status fall back to `pending` rather than being dropped: a
 * todo the agent wrote must stay on screen, and dropping it silently shrinks
 * the plan mid-run for no visible reason.
 *
 * A `pending` tool part carries `input: {}` (opencode publishes the part before
 * the arguments finish parsing), which lands on the `!Array.isArray` guard and
 * maps to zero events — so a streaming part cannot clobber a good plan.
 */
function planEntriesOf(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') continue;
    const status = PLAN_STATUSES.find((s) => s === todo.status) ?? 'pending';
    const entry: PlanEntry = { content: todo.content, status };
    if (todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low') {
      entry.priority = todo.priority;
    }
    entries.push(entry);
  }
  return entries;
}

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/** `patch` parts snapshot applied file changes → a completed edit-tool item
 *  carrying `diffs` (unified when the wire includes content; the older
 *  paths-only shape still yields per-file entries + locations). */
function mapPatch(
  part: Record<string, unknown>,
  id: string,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (state.endedItems.has(id)) return { events: [], state };
  const artifacts = patchArtifacts(part.files);
  if (!artifacts) return { events: [], state };
  const { diffs, locations } = artifacts;
  const label =
    locations.length === 1 ? locations[0]?.path : locations.length > 1 ? `${locations.length} files` : undefined;
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name: 'patch',
    toolKind: 'edit',
    title: label !== undefined ? `Edit ${label}` : 'Edit',
    status: 'completed',
    diffs,
    locations,
  };
  if (parentItemId !== undefined) item.parentItemId = parentItemId;
  return {
    events: [{ type: 'item.completed', item }],
    state: { ...state, endedItems: new Set(state.endedItems).add(id) },
  };
}

/** `files` as `{path: unifiedDiff}` record (or `[{path, diff}]`) carries the
 *  content; the paths-only `string[]` shape still yields diff entries.
 *  Opencode sends unified diffs only — old text is unknown, never "empty". */
function patchArtifacts(files: unknown): { diffs: FileDiff[]; locations: ToolLocation[] } | undefined {
  const diffs: FileDiff[] = [];
  const push = (path: string, unified?: string): void => {
    const diff: FileDiff = { path, oldText: null };
    if (unified !== undefined) diff.unified = unified;
    diffs.push(diff);
  };
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (typeof entry === 'string' && entry !== '') push(entry);
      else if (isRecord(entry)) {
        const path = str(entry.path) ?? str(entry.file) ?? str(entry.filename);
        if (path !== undefined) push(path, str(entry.diff) ?? str(entry.patch));
      }
    }
  } else if (isRecord(files)) {
    for (const [path, value] of Object.entries(files)) {
      if (path === '') continue;
      if (typeof value === 'string') push(path, str(value));
      else if (isRecord(value)) push(path, str(value.diff) ?? str(value.patch));
      else push(path);
    }
  }
  if (diffs.length === 0) return undefined;
  return { diffs, locations: diffs.map((d) => ({ path: d.path })) };
}

/** `subtask` parts spawn a child session → a task-kind tool item whose id
 *  scopes subsequent foreign-session items via `parentItemId` (§7.1); the
 *  child's `session.idle` completes it. */
function mapSubtask(
  part: Record<string, unknown>,
  id: string,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (state.startedItems.has(id)) return { events: [], state };
  const description = str(part.description);
  const display = toolDisplay('task', { description });
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name: 'subtask',
    toolKind: display.toolKind,
    title: display.title,
    status: 'running',
  };
  const input: Record<string, unknown> = {};
  if (str(part.prompt) !== undefined) input.prompt = part.prompt;
  if (description !== undefined) input.description = description;
  if (str(part.agent) !== undefined) input.agent = part.agent;
  if (Object.keys(input).length > 0) item.input = input;
  return {
    events: [{ type: 'item.started', item }],
    state: {
      ...state,
      startedItems: new Set(state.startedItems).add(id),
      unboundSubtasks: [...state.unboundSubtasks, { id, title: item.title, input: item.input }],
    },
  };
}

/** `step-finish` parts carry per-LLM-round-trip cost + tokens → summed as
 *  usage increments (the larger of this sum and the `message.updated`
 *  snapshot wins per message — see `MessageUsage`). */
function mapStepFinish(
  part: Record<string, unknown>,
  messageID: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (messageID === undefined) return { events: [], state };
  const tokens = tokensToUsage(part.tokens);
  const cost = num(part.cost);
  if (!tokens && cost === undefined) return { events: [], state };
  const prev = state.usageByMessage.get(messageID) ?? EMPTY_MESSAGE_USAGE;
  const merged: MessageUsage = {
    info: prev.info,
    infoCost: prev.infoCost,
    steps: tokens ? addUsage(prev.steps, tokens) : prev.steps,
    stepsCost: cost !== undefined ? (prev.stepsCost ?? 0) + cost : prev.stepsCost,
  };
  const usageByMessage = new Map(state.usageByMessage);
  usageByMessage.set(messageID, merged);
  const currentTurnMessageIds =
    state.currentTurnId !== null
      ? new Set(state.currentTurnMessageIds).add(messageID)
      : state.currentTurnMessageIds;
  return emitUsage({ ...state, usageByMessage, currentTurnMessageIds });
}

// ---- session lifecycle -------------------------------------------------------

/** `session.idle` is THE turn-end signal (§4.1). The main session's idle
 *  closes the current turn; a foreign idle is the subtask's child session
 *  going quiet → the subtask item completes. */
function mapIdle(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const sid = str(props.sessionID);
  const isMain = sid === undefined || state.sessionId === null || sid === state.sessionId;
  if (!isMain) {
    if (sid === undefined) return { events: [], state };
    const resolved = resolveSubtask(sid, state);
    if (resolved.subtask === undefined) return { events: [], state };
    const subtasks = new Map(resolved.state.subtasks);
    subtasks.delete(sid);
    return {
      events: [{ type: 'item.completed', item: completedSubtask(resolved.subtask) }],
      state: { ...resolved.state, subtasks },
    };
  }
  // Idle with no turn in flight (or a repeated idle) closes nothing.
  if (state.currentTurnId === null) return { events: [], state };
  const openSubtasks = [...state.subtasks.values(), ...state.unboundSubtasks];
  const completed: Extract<UiEvent, { type: 'turn.completed' }> = {
    type: 'turn.completed',
    turnId: state.currentTurnId,
    stopReason: state.turnErrored ? 'error' : 'end_turn',
  };
  const turnUsage = usageForMessages(state.currentTurnMessageIds, state.usageByMessage);
  if (turnUsage.usage !== null) completed.usage = turnUsage.usage;
  if (turnUsage.cost !== null) completed.costUsd = turnUsage.cost;
  return {
    events: [
      ...openSubtasks.map((subtask): UiEvent => ({ type: 'item.completed', item: completedSubtask(subtask) })),
      completed,
    ],
    state: {
      ...state,
      currentTurnId: null,
      currentTurnMessageIds: new Set(),
      turnErrored: false,
      subtasks: new Map(),
      unboundSubtasks: [],
    },
  };
}

/** `session.error` → non-fatal `session.error` (the mapper can't know the
 *  session died — the runner owns fatality) + the turn closes as 'error'. */
function mapSessionError(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const sid = str(props.sessionID);
  const foreign = sid !== undefined && state.sessionId !== null && sid !== state.sessionId;
  const resolved = foreign && sid !== undefined ? resolveSubtask(sid, state) : undefined;
  if (foreign && resolved?.subtask === undefined) return { events: [], state };
  state = resolved?.state ?? state;
  const message = errorText(props.error) ?? 'opencode session error';
  return {
    events: [{ type: 'session.error', message, fatal: false }],
    state: { ...state, turnErrored: state.currentTurnId !== null ? true : state.turnErrored },
  };
}

function resolveSubtask(
  sessionId: string,
  state: OpencodeUiMapperState,
): { state: OpencodeUiMapperState; subtask?: SubtaskScope } {
  const existing = state.subtasks.get(sessionId);
  if (existing !== undefined) return { state, subtask: existing };
  if (state.unboundSubtasks.length !== 1) return { state };
  const subtask = state.unboundSubtasks[0];
  if (subtask === undefined) return { state };
  const subtasks = new Map(state.subtasks);
  subtasks.set(sessionId, subtask);
  return { state: { ...state, subtasks, unboundSubtasks: [] }, subtask };
}

function completedSubtask(subtask: SubtaskScope): UiToolItem {
  const item: UiToolItem = {
    kind: 'tool',
    id: subtask.id,
    name: 'subtask',
    toolKind: 'task',
    title: subtask.title,
    status: 'completed',
  };
  if (subtask.input !== undefined) item.input = subtask.input;
  return item;
}

// ---- telemetry ----------------------------------------------------------------

const EMPTY_MESSAGE_USAGE: MessageUsage = { info: null, infoCost: null, steps: null, stepsCost: null };

/** `{input, output, reasoning, cache:{read,write}}` → raw TokenUsage
 *  (opencode reports no total — the sum of the parts is the total). */
function tokensToUsage(tokens: unknown): TokenUsage | undefined {
  if (!isRecord(tokens)) return undefined;
  const input = num(tokens.input) ?? 0;
  const output = num(tokens.output) ?? 0;
  const reasoning = num(tokens.reasoning);
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const cacheRead = cache ? num(cache.read) : undefined;
  const cacheWrite = cache ? num(cache.write) : undefined;
  const usage: TokenUsage = {
    input,
    output,
    total: input + output + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

function addUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (a === null) return b;
  const sum: TokenUsage = { input: a.input + b.input, output: a.output + b.output, total: a.total + b.total };
  const cacheRead = optSum(a.cacheRead, b.cacheRead);
  if (cacheRead !== undefined) sum.cacheRead = cacheRead;
  const cacheWrite = optSum(a.cacheWrite, b.cacheWrite);
  if (cacheWrite !== undefined) sum.cacheWrite = cacheWrite;
  const reasoning = optSum(a.reasoning, b.reasoning);
  if (reasoning !== undefined) sum.reasoning = reasoning;
  return sum;
}

function optSum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function maxCost(a: number | null, b: number | undefined): number | null {
  if (b === undefined) return a;
  return a === null ? b : Math.max(a, b);
}

/** Session totals = per-message effective usage summed across messages;
 *  emitted only when the snapshot actually changed and is non-zero. */
function emitUsage(state: OpencodeUiMapperState): OpencodeUiMapping {
  let usage: TokenUsage = { input: 0, output: 0, total: 0 };
  let cost: number | null = null;
  for (const mu of state.usageByMessage.values()) {
    const effective = mu.info !== null && (mu.steps === null || mu.info.total >= mu.steps.total) ? mu.info : mu.steps;
    if (effective !== null) usage = addUsage(usage, effective);
    const effCost = maxCost(mu.infoCost, mu.stepsCost ?? undefined);
    if (effCost !== null) cost = (cost ?? 0) + effCost;
  }
  if (usage.total === 0 && (cost === null || cost === 0)) return { events: [], state };
  if (state.lastUsage !== null && state.lastUsage.total === usage.total && state.lastUsage.cost === cost) {
    return { events: [], state };
  }
  const event: UiUsageUpdatedEvent = { type: 'usage.updated', usage };
  if (cost !== null) event.costUsd = cost;
  return { events: [event], state: { ...state, lastUsage: { total: usage.total, cost } } };
}

function usageForMessages(
  messageIds: ReadonlySet<string>,
  usageByMessage: ReadonlyMap<string, MessageUsage>,
): { usage: TokenUsage | null; cost: number | null } {
  let usage: TokenUsage | null = null;
  let cost: number | null = null;
  for (const id of messageIds) {
    const message = usageByMessage.get(id);
    if (message === undefined) continue;
    const effective =
      message.info !== null && (message.steps === null || message.info.total >= message.steps.total)
        ? message.info
        : message.steps;
    if (effective !== null && (effective.input > 0 || effective.output > 0)) usage = addUsage(usage, effective);
    const effectiveCost = maxCost(message.infoCost, message.stepsCost ?? undefined);
    if (effectiveCost !== null && effectiveCost > 0) cost = (cost ?? 0) + effectiveCost;
  }
  return { usage, cost };
}

// ---- tiny guards ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Opencode error objects are `{name, data:{message}}` (or plain strings). */
function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return str(error);
  if (!isRecord(error)) return undefined;
  const data = isRecord(error.data) ? error.data : undefined;
  return str(error.message) ?? (data && str(data.message)) ?? str(error.name);
}

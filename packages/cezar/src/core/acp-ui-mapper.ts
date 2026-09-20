/**
 * Pure Agent Client Protocol → normalized protocol-v2 mapper, shared by every ACP runner (spec
 * `2026-09-19-runner-seam-native-backends` § "The shared ACP layer"; `AGENT_PROTOCOL.md` §4).
 *
 * It maps RAW JSON-RPC frames in wire order — both directions, exactly what `AcpClient`'s `onFrame`
 * tap hands out — so a golden fixture is literally a captured transcript. Outbound requests are
 * remembered by id, which is how an inbound answer is known to be the `session/new` result (→
 * `session.started`) or the `session/prompt` result (→ `turn.completed`). `(frame, state) →
 * {events, state}`: explicit immutable state, never throws, unknown or malformed frames yield no
 * events (the mapper robustness contract).
 *
 * What differs between agents is a small `AcpDialect` (tool names, tool kinds, usage, plans,
 * error wording); fixtures, the mapper test and the parity row stay per runner.
 */
import type {
  FileDiff,
  PlanEntry,
  StopReason,
  TokenUsage,
  ToolKind,
  ToolLocation,
  ToolStatus,
  UiBackend,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

/** One frame as the `AcpClient` tap reports it — and as a golden fixture line stores it. */
export interface AcpFrame {
  dir: 'in' | 'out';
  frame: unknown;
}

/** The per-agent knowledge the shared mapper needs. Everything is optional except the identity. */
export interface AcpDialect {
  readonly backend: UiBackend;
  /** The agent's own tool name for a `tool_call` (ACP carries a title and a kind, not a name). */
  toolNameOf(update: Record<string, unknown>): string;
  /** A kind the ACP `kind` field cannot express (a subagent delegation → `task`). */
  toolKindOf?(name: string, update: Record<string, unknown>): ToolKind | undefined;
  /** Per-turn token counts from the `session/prompt` result, when the agent reports them off-schema. */
  usageFromPromptResult?(result: Record<string, unknown>): TokenUsage | undefined;
  /** Plan entries carried by a tool call (for agents whose plan is a tool, not a `plan` update). */
  planFromToolCall?(name: string, update: Record<string, unknown>): PlanEntry[] | undefined;
  /** The user-facing line for a JSON-RPC error — lets a dialect replace vendor prose (auth hints). */
  errorMessage?(error: Record<string, unknown>): string | undefined;
}

export interface AcpUiMapperState {
  /** Outbound requests still waiting for their answer, keyed by `String(id)`. */
  readonly requests: ReadonlyMap<string, { method: string; params: Record<string, unknown> }>;
  readonly sessionId: string | null;
  readonly turnSeq: number;
  readonly turnId: string | null;
  /**
   * True from an outbound `session/load` until the agent's replay of that session's history is over.
   * Gemini replays every past message, thought and tool call as `session/update` frames — some
   * before, some after the load result — and ends with `available_commands_update`
   * (`__fixtures__/gemini/load-replay.ndjson`). cezar already has that history in its own NDJSON,
   * so the replay must not become a second copy of every item. Only that marker ends it — or the
   * runner, through `endAcpReplay`, when it gives up waiting for one. An early `session/prompt` does
   * NOT: in the captured transcript the client prompted mid-replay, and the rest of the replay (old
   * tool calls, an old "DONE") still arrived before the live answer.
   */
  readonly replaying: boolean;
  readonly itemSeq: number;
  /** The message or reasoning item chunks are currently appended to. */
  readonly openText: { readonly id: string; readonly kind: 'message' | 'reasoning'; readonly text: string } | null;
  readonly tools: ReadonlyMap<string, UiToolItem>;
  /** Cumulative-for-session usage (`usage.updated` semantics). */
  readonly sessionUsage: TokenUsage | null;
}

export interface AcpUiMapping {
  events: UiEvent[];
  state: AcpUiMapperState;
}

export function createAcpUiState(): AcpUiMapperState {
  return {
    requests: new Map(),
    sessionId: null,
    turnSeq: 0,
    turnId: null,
    replaying: false,
    itemSeq: 0,
    openText: null,
    tools: new Map(),
    sessionUsage: null,
  };
}

const NONE = (state: AcpUiMapperState): AcpUiMapping => ({ events: [], state });

/** The runner's own end of a `session/load` replay, for an agent that never sends the marker. */
export function endAcpReplay(state: AcpUiMapperState): AcpUiMapperState {
  return state.replaying ? { ...state, replaying: false } : state;
}

/**
 * A turn the transport lost: the agent died or was stopped mid-prompt, so no answer frame will
 * ever come. With a `message` it settles exactly as an error answer would (`session.error`, then
 * `turn.completed{error}`); without one it settles with `stopReason` — `cancelled` for a stop cezar
 * asked for, `timeout` for the run's own deadline.
 */
export function abortAcpTurn(
  state: AcpUiMapperState,
  dialect: AcpDialect,
  stopReason: StopReason,
  message?: string,
): AcpUiMapping {
  return message !== undefined
    ? completeTurn(state, dialect, undefined, { message })
    : completeTurn(state, dialect, undefined, undefined, stopReason);
}

export function mapAcpFrame(input: AcpFrame | unknown, state: AcpUiMapperState, dialect: AcpDialect): AcpUiMapping {
  if (!isRecord(input) || (input.dir !== 'in' && input.dir !== 'out') || !isRecord(input.frame)) return NONE(state);
  const frame = input.frame;
  const method = string(frame.method);
  const id = frame.id;
  const hasId = typeof id === 'number' || typeof id === 'string';

  if (input.dir === 'out') {
    // Only requests cezar sends matter here; its answers to inbound requests and its notifications
    // (`session/cancel`) change nothing the cockpit renders.
    if (!method || !hasId) return NONE(state);
    const params = isRecord(frame.params) ? frame.params : {};
    const requests = new Map(state.requests);
    requests.set(String(id), { method, params });
    let next: AcpUiMapperState = { ...state, requests };
    if (method === 'session/load') next = { ...next, replaying: true };
    if (method !== 'session/prompt') return NONE(next);
    const turnSeq = state.turnSeq + 1;
    const turnId = `turn_${turnSeq}`;
    return {
      events: [{ type: 'turn.started', turnId }],
      state: { ...next, turnSeq, turnId, openText: null },
    };
  }

  // Inbound.
  if (method) {
    if (method === 'session/update') return mapUpdate(frame.params, state, dialect);
    if (method === 'session/request_permission' && hasId) return mapPermissionRequest(frame.params, state, dialect);
    return NONE(state);
  }
  if (!hasId) return NONE(state);
  const request = state.requests.get(String(id));
  if (!request) return NONE(state);
  const requests = new Map(state.requests);
  requests.delete(String(id));
  const next: AcpUiMapperState = { ...state, requests };
  const result = isRecord(frame.result) ? frame.result : undefined;
  const error = frame.error !== undefined ? (isRecord(frame.error) ? frame.error : { message: String(frame.error) }) : undefined;

  switch (request.method) {
    case 'session/new':
    case 'session/load':
      if (error) {
        // A failed load is recoverable — the runner starts a fresh session — a failed new is not.
        return {
          events: [{ type: 'session.error', message: errorText(error, dialect), fatal: request.method === 'session/new' }],
          state: { ...next, replaying: false },
        };
      }
      return startSession(request, result ?? {}, next, dialect);
    case 'session/prompt':
      return completeTurn(next, dialect, result, error);
    default:
      return NONE(next);
  }
}

function startSession(
  request: { method: string; params: Record<string, unknown> },
  result: Record<string, unknown>,
  state: AcpUiMapperState,
  dialect: AcpDialect,
): AcpUiMapping {
  // `session/new` mints the id; `session/load` answers without one — it is the id cezar asked for.
  const sessionId = string(result.sessionId) ?? string(request.params.sessionId);
  if (!sessionId || sessionId === state.sessionId) return NONE(state);
  const models = isRecord(result.models) ? result.models : undefined;
  const model = models ? string(models.currentModelId) : undefined;
  const cwd = string(request.params.cwd);
  return {
    events: [
      {
        type: 'session.started',
        sessionId,
        backend: dialect.backend,
        ...(model ? { model } : {}),
        ...(cwd ? { cwd } : {}),
      },
    ],
    state: { ...state, sessionId },
  };
}

function mapUpdate(params: unknown, state: AcpUiMapperState, dialect: AcpDialect): AcpUiMapping {
  if (!isRecord(params) || !isRecord(params.update)) return NONE(state);
  const update = params.update;
  const kind = string(update.sessionUpdate);
  if (kind === 'available_commands_update') return state.replaying ? NONE({ ...state, replaying: false }) : NONE(state);
  // Replayed history, and anything outside a turn (a `set_mode` echo), renders nothing.
  if (state.replaying || !state.turnId) return NONE(state);
  switch (kind) {
    case 'agent_message_chunk':
      return appendText('message', update.content, state);
    case 'agent_thought_chunk':
      return appendText('reasoning', update.content, state);
    case 'tool_call':
      return upsertTool(update, state, dialect, true);
    case 'tool_call_update':
      return upsertTool(update, state, dialect, false);
    case 'plan': {
      const entries = planEntries(update.entries);
      return entries ? { events: [{ type: 'plan.updated', entries }], state } : NONE(state);
    }
    default:
      // user_message_chunk, current_mode_update, usage_update, … — nothing to render (yet).
      return NONE(state);
  }
}

function appendText(kind: 'message' | 'reasoning', content: unknown, state: AcpUiMapperState): AcpUiMapping {
  if (!isRecord(content)) return NONE(state);
  if (content.type === 'image') {
    const data = string(content.data);
    const mediaType = string(content.mimeType);
    return data && mediaType ? { events: [{ type: 'image', mediaType, data }], state } : NONE(state);
  }
  const delta = content.type === 'text' ? string(content.text) : undefined;
  if (delta === undefined) return NONE(state);

  const events: UiEvent[] = [];
  let next = state;
  if (next.openText && next.openText.kind !== kind) {
    const closed = closeText(next);
    events.push(...closed.events);
    next = closed.state;
  }
  let open = next.openText;
  if (!open) {
    const itemSeq = next.itemSeq + 1;
    open = { id: `${next.turnId}_${kind === 'message' ? 'msg' : 'reasoning'}_${itemSeq}`, kind, text: '' };
    next = { ...next, itemSeq };
    events.push({ type: 'item.started', item: textItem(open.id, kind, '') });
  }
  events.push({ type: 'item.delta', itemId: open.id, field: kind === 'message' ? 'text' : 'reasoning', delta });
  return { events, state: { ...next, openText: { ...open, text: open.text + delta } } };
}

function closeText(state: AcpUiMapperState): AcpUiMapping {
  const open = state.openText;
  if (!open) return NONE(state);
  return { events: [{ type: 'item.completed', item: textItem(open.id, open.kind, open.text) }], state: { ...state, openText: null } };
}

function textItem(id: string, kind: 'message' | 'reasoning', text: string): UiMessageItem | UiReasoningItem {
  return kind === 'message' ? { kind: 'message', id, role: 'assistant', text } : { kind: 'reasoning', id, text };
}

function upsertTool(
  update: Record<string, unknown>,
  state: AcpUiMapperState,
  dialect: AcpDialect,
  isCall: boolean,
): AcpUiMapping {
  const toolCallId = string(update.toolCallId);
  if (!toolCallId) return NONE(state);
  const closed = closeText(state);
  const events = [...closed.events];
  let next = closed.state;

  const previous = next.tools.get(toolCallId);
  const status = toolStatus(update.status) ?? previous?.status ?? (isCall ? 'running' : undefined);
  if (!status) return { events, state: next };
  const name = previous?.name ?? dialect.toolNameOf(update);
  const rawInput = update.rawInput;
  const display = toolDisplay(name, rawInput ?? previous?.input);
  const content = toolContent(update.content);
  const failed = status === 'failed';
  const item: UiToolItem = {
    ...(previous ?? {}),
    kind: 'tool',
    id: toolCallId,
    name,
    toolKind: previous?.toolKind ?? dialect.toolKindOf?.(name, update) ?? acpToolKind(update.kind) ?? display.toolKind,
    // A `failed` update carries no title on Gemini (`write-todos-quota.ndjson`): keep the one we had.
    title: string(update.title) || previous?.title || display.title,
    status,
  };
  if (rawInput !== undefined) item.input = rawInput;
  const locations = toolLocations(update.locations);
  if (locations) item.locations = locations;
  if (content.diffs.length > 0) item.diffs = content.diffs;
  // The text of a starting call is the agent's explanation of what it is about to do, not output.
  if (!isCall && content.text !== undefined) {
    if (failed) item.error = content.text;
    else item.output = content.text;
  }
  if (failed && item.error === undefined) item.error = 'tool failed';

  const tools = new Map(next.tools);
  tools.set(toolCallId, item);
  next = { ...next, tools };
  const terminal = status === 'completed' || status === 'failed' || status === 'declined';
  if (!previous) events.push({ type: 'item.started', item });
  if (terminal) events.push({ type: 'item.completed', item });
  else if (previous) events.push({ type: 'item.updated', item });

  const plan = dialect.planFromToolCall?.(name, update);
  if (plan) events.push({ type: 'plan.updated', entries: plan });
  return { events, state: next };
}

function mapPermissionRequest(params: unknown, state: AcpUiMapperState, dialect: AcpDialect): AcpUiMapping {
  // Gemini sends no `tool_call` for a call that needed approval: the request's `toolCall` is the
  // only announcement, then a `tool_call_update` finishes it (`__fixtures__/gemini/permission.ndjson`).
  // The request itself is answered by the runner (Q15: auto `allow_always` + a v1 note).
  if (!isRecord(params) || !isRecord(params.toolCall) || state.replaying || !state.turnId) return NONE(state);
  const toolCall = params.toolCall;
  const toolCallId = string(toolCall.toolCallId);
  if (!toolCallId || state.tools.has(toolCallId)) return NONE(state);
  return upsertTool({ ...toolCall, status: toolCall.status ?? 'pending' }, state, dialect, true);
}

function completeTurn(
  state: AcpUiMapperState,
  dialect: AcpDialect,
  result: Record<string, unknown> | undefined,
  error: Record<string, unknown> | undefined,
  forced?: StopReason,
): AcpUiMapping {
  const closed = closeText(state);
  const events = [...closed.events];
  let next = closed.state;
  if (!next.turnId) return { events, state: next };

  const stopReason: StopReason = error ? 'error' : forced ?? stopReasonOf(result?.stopReason);
  // Tools a cancelled or failed turn left running would spin forever: settle them as failed.
  if (stopReason !== 'end_turn') {
    const tools = new Map(next.tools);
    for (const [id, tool] of next.tools) {
      if (tool.status !== 'pending' && tool.status !== 'running') continue;
      const item: UiToolItem = { ...tool, status: 'failed', error: `turn ended (${stopReason}) before the tool finished` };
      tools.set(id, item);
      events.push({ type: 'item.completed', item });
    }
    next = { ...next, tools };
  }
  if (error) events.push({ type: 'session.error', message: errorText(error, dialect), fatal: false });

  const usage = result ? dialect.usageFromPromptResult?.(result) ?? standardUsage(result.usage) : undefined;
  if (usage) {
    const sessionUsage = addUsage(next.sessionUsage, usage);
    events.push({ type: 'usage.updated', usage: sessionUsage });
    next = { ...next, sessionUsage };
  }
  const completed: Extract<UiEvent, { type: 'turn.completed' }> = { type: 'turn.completed', turnId: next.turnId!, stopReason };
  if (usage) completed.usage = usage;
  events.push(completed);
  return { events, state: { ...next, turnId: null } };
}

/** ACP `StopReason` → v2. `max_turn_requests` has no v2 twin; it is a length stop like `max_tokens`. */
export function stopReasonOf(value: unknown): StopReason {
  switch (value) {
    case 'max_tokens':
    case 'max_turn_requests':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'end_turn';
  }
}

function toolStatus(value: unknown): ToolStatus | undefined {
  switch (value) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

/** ACP tool kinds are v2 tool kinds by design; `switch_mode` and anything unknown are `other`. */
function acpToolKind(value: unknown): ToolKind | undefined {
  switch (value) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'think':
    case 'fetch':
    case 'other':
      return value;
    case 'switch_mode':
      return 'other';
    default:
      return undefined;
  }
}

function toolContent(value: unknown): { text?: string; diffs: FileDiff[] } {
  const diffs: FileDiff[] = [];
  const texts: string[] = [];
  if (!Array.isArray(value)) return { diffs };
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === 'diff') {
      const path = string(part.path);
      if (!path) continue;
      const newText = string(part.newText);
      diffs.push({ path, oldText: string(part.oldText) ?? null, ...(newText !== undefined ? { newText } : {}) });
    } else if (part.type === 'content' && isRecord(part.content) && part.content.type === 'text') {
      const text = string(part.content.text);
      if (text) texts.push(text);
    }
  }
  return texts.length > 0 ? { text: texts.join('\n'), diffs } : { diffs };
}

function toolLocations(value: unknown): ToolLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: ToolLocation[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = string(entry.path);
    if (!path) continue;
    const line = number(entry.line);
    locations.push(line !== undefined ? { path, line } : { path });
  }
  return locations.length > 0 ? locations : undefined;
}

/** An ACP `plan` update's entries (`{content, priority, status}`). Malformed entries are dropped;
 *  a non-array yields no plan at all — only a genuinely empty list clears the dock. */
function planEntries(value: unknown): PlanEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: PlanEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const content = string(entry.content);
    if (!content) continue;
    const status = entry.status === 'in_progress' || entry.status === 'completed' ? entry.status : 'pending';
    const priority = entry.priority === 'high' || entry.priority === 'medium' || entry.priority === 'low' ? entry.priority : undefined;
    entries.push({ content, status, ...(priority ? { priority } : {}) });
  }
  return entries;
}

/** The ACP-standard `PromptResponse.usage` (`inputTokens`, `outputTokens`, …). */
function standardUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.inputTokens) ?? 0;
  const output = number(value.outputTokens) ?? 0;
  const cacheRead = number(value.cachedReadTokens);
  const cacheWrite = number(value.cachedWriteTokens);
  const reasoning = number(value.thoughtTokens);
  const total = number(value.totalTokens) ?? input + output;
  if (total <= 0) return undefined;
  return {
    input,
    output,
    total,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function addUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const cacheRead = sum(a.cacheRead, b.cacheRead);
  const cacheWrite = sum(a.cacheWrite, b.cacheWrite);
  const reasoning = sum(a.reasoning, b.reasoning);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function errorText(error: Record<string, unknown>, dialect: AcpDialect): string {
  const dialectText = dialect.errorMessage?.(error);
  if (dialectText) return dialectText;
  const message = string(error.message) ?? 'ACP request failed';
  const details = isRecord(error.data) ? string(error.data.details) : undefined;
  return details ? `${message}: ${details}` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Pure Kimi Code → normalized protocol-v2 mapper.
 *
 * Kimi Code (`kimi`, the successor to the Python `kimi-cli`) is driven over the
 * Agent Client Protocol: `kimi acp` speaks JSON-RPC 2.0 over stdio.
 * Contract: https://agentclientprotocol.com — session/new, session/prompt, and
 * the `session/update` notifications this mapper reads.
 *
 * Two inputs, both real wire data, fed by `KimiRunner` in this order:
 *
 *  - the agent's JSON-RPC messages: `session/update` notifications and the
 *    responses to `session/new` (the session) and `session/prompt` (the end of
 *    a turn, with its stop reason);
 *  - `usage.record` lines from Kimi's OWN session log. ACP carries no per-turn
 *    token counts — only `usage_update`, which is context-window occupancy — so
 *    the runner reads them from `~/.kimi-code/sessions/…/wire.jsonl` when a turn
 *    ends and feeds them BEFORE the prompt response that ends it, so
 *    `turn.completed` carries the turn's directional usage like every backend.
 *
 * A tool call arrives as: `tool_call` (pending — its `title` is the tool NAME),
 * a run of `in_progress` updates streaming the ARGUMENTS as partial JSON (not
 * output — ignored), one update carrying the final `rawInput` and a friendly
 * title, then `completed`/`failed` with the OUTPUT.
 *
 * Unknown or malformed wire data is ignored; this mapper never throws.
 */
import type {
  FileDiff,
  PlanEntry,
  StopReason,
  TokenUsage,
  ToolKind,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.js';
import { toolDisplay } from './tool-display.js';

export interface KimiUiMapperState {
  readonly sessionStarted: boolean;
  readonly sessionId: string | null;
  readonly turnSeq: number;
  readonly turnId: string | null;
  /** The text/reasoning item currently receiving chunks, if any. */
  readonly open: { readonly id: string; readonly field: 'text' | 'reasoning'; readonly text: string } | null;
  /** Counts text/reasoning items within the turn, for stable ids. */
  readonly itemSeq: number;
  readonly tools: ReadonlyMap<string, UiToolItem>;
  /** Summed over the turn's `usage.record`s; reset when the turn ends. */
  readonly turnUsage: TokenUsage | null;
  /** From `usage_update.size`, carried onto usage events. */
  readonly contextWindow: number | null;
  /** The last plan emitted, as content+status: Kimi reports one TodoList change twice — as the
   *  tool's input AND as a native ACP `plan` update — and the cockpit should see it once. */
  readonly planKey: string | null;
}

export interface KimiUiMapping {
  events: UiEvent[];
  state: KimiUiMapperState;
}

export function createKimiUiState(): KimiUiMapperState {
  return {
    sessionStarted: false,
    sessionId: null,
    turnSeq: 0,
    turnId: null,
    open: null,
    itemSeq: 0,
    tools: new Map(),
    turnUsage: null,
    contextWindow: null,
    planKey: null,
  };
}

/**
 * The session is ready: created (`session/new`) or reopened (`session/resume`, which answers
 * without an id — the runner already knows it) AND its model selected, so `configOptions` is the
 * latest the agent reported and `model` names what the session will really run on, not the
 * account default it opened with. Deduplicated: only the first counts.
 */
export function kimiSessionStarted(
  state: KimiUiMapperState,
  sessionId: string,
  configOptions?: unknown,
): KimiUiMapping {
  if (state.sessionStarted) return { events: [], state };
  const model = currentModel(configOptions);
  return {
    events: [{ type: 'session.started', sessionId, backend: 'kimi', ...(model ? { model } : {}) }],
    state: { ...state, sessionStarted: true, sessionId },
  };
}

/** The runner sent `session/prompt`: a turn begins. */
export function kimiTurnStarted(state: KimiUiMapperState): KimiUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: { ...state, turnSeq, turnId, open: null, itemSeq: 0, turnUsage: null },
  };
}

export function mapKimiMessage(value: unknown, state: KimiUiMapperState): KimiUiMapping {
  if (!isRecord(value)) return { events: [], state };

  // Kimi's own session log: per-request token usage (see the header).
  if (value.type === 'usage.record') return mapUsageRecord(value, state);

  // JSON-RPC error responses. During a turn the only request in flight is the
  // `session/prompt` itself, so an error there IS the turn failing — a quota
  // 403 arrives exactly this way — and the turn must end, not hang open.
  if (isRecord(value.error)) {
    const message = string(value.error.message) ?? 'kimi request failed';
    const failed: UiEvent = { type: 'session.error', message, fatal: false };
    if (!state.turnId) return { events: [failed], state };
    const ended = completeTurn('error', state);
    return { events: [failed, ...ended.events], state: ended.state };
  }

  // A `session/prompt` result is told apart by its SHAPE, which is what ACP guarantees: it alone
  // carries a stopReason. The session itself starts through `kimiSessionStarted`.
  if (isRecord(value.result)) {
    const stopReason = string(value.result.stopReason);
    return stopReason !== undefined ? completeTurn(acpStopReason(stopReason), state) : { events: [], state };
  }

  if (value.method !== 'session/update' || !isRecord(value.params) || !isRecord(value.params.update)) {
    return { events: [], state };
  }
  const update = value.params.update;
  switch (string(update.sessionUpdate)) {
    case 'agent_message_chunk':
      return appendChunk('text', update, state);
    case 'agent_thought_chunk':
      return appendChunk('reasoning', update, state);
    case 'tool_call':
      return mapToolCall(update, state);
    case 'tool_call_update':
      return mapToolCallUpdate(update, state);
    case 'plan':
      return mapAcpPlan(update, state);
    case 'usage_update': {
      const size = number(update.size);
      return { events: [], state: size ? { ...state, contextWindow: size } : state };
    }
    default:
      return { events: [], state };
  }
}

/** Close whatever text/reasoning item is open, so the next thing starts fresh. */
function closeOpen(state: KimiUiMapperState): KimiUiMapping {
  if (!state.open) return { events: [], state };
  const { id, field, text } = state.open;
  const item: UiMessageItem | UiReasoningItem =
    field === 'text' ? { kind: 'message', id, role: 'assistant', text } : { kind: 'reasoning', id, text };
  return { events: [{ type: 'item.completed', item }], state: { ...state, open: null } };
}

function appendChunk(
  field: 'text' | 'reasoning',
  update: Record<string, unknown>,
  state: KimiUiMapperState,
): KimiUiMapping {
  const content = isRecord(update.content) ? update.content : undefined;
  const delta = content && content.type === 'text' ? string(content.text) : undefined;
  // Kimi opens a thought with an empty chunk; an item for it would render as a dead
  // "Thinking —" row (#528) when no text follows.
  if (!delta || !state.turnId) return { events: [], state };

  const events: UiEvent[] = [];
  let next = state;
  // Thought and message chunks interleave with tools: each run becomes its own
  // item, in order, rather than one item that jumps around the transcript.
  if (next.open && next.open.field !== field) {
    const closed = closeOpen(next);
    events.push(...closed.events);
    next = closed.state;
  }
  if (!next.open) {
    const id = `${next.turnId}_${field}_${next.itemSeq}`;
    const item: UiMessageItem | UiReasoningItem =
      field === 'text' ? { kind: 'message', id, role: 'assistant', text: '' } : { kind: 'reasoning', id, text: '' };
    events.push({ type: 'item.started', item });
    next = { ...next, open: { id, field, text: '' }, itemSeq: next.itemSeq + 1 };
  }
  const open = next.open as NonNullable<KimiUiMapperState['open']>;
  events.push({ type: 'item.delta', itemId: open.id, field, delta });
  return { events, state: { ...next, open: { ...open, text: open.text + delta } } };
}

function mapToolCall(update: Record<string, unknown>, state: KimiUiMapperState): KimiUiMapping {
  const id = string(update.toolCallId);
  // The first event's title IS the tool name (`Read`, `Edit`, `Bash`, `Agent`).
  const name = string(update.title);
  if (!id || !name) return { events: [], state };
  const closed = closeOpen(state);
  const display = toolDisplay(name, undefined);
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name,
    toolKind: toolKindFor(display.toolKind, update.kind),
    title: display.title,
    status: 'running',
  };
  const tools = new Map(closed.state.tools);
  tools.set(id, item);
  return {
    events: [...closed.events, { type: 'item.started', item }],
    state: { ...closed.state, tools },
  };
}

function mapToolCallUpdate(update: Record<string, unknown>, state: KimiUiMapperState): KimiUiMapping {
  const id = string(update.toolCallId);
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const status = string(update.status);

  if (status === 'completed' || status === 'failed') {
    const output = contentText(update.content);
    const failed = status === 'failed';
    const item: UiToolItem = {
      ...previous,
      status: failed ? 'failed' : 'completed',
      ...(failed ? { error: output ?? 'kimi tool failed' } : output !== undefined ? { output } : {}),
    };
    const diffs = previous.diffs ?? contentDiffs(update.content);
    if (diffs) item.diffs = diffs;
    return replaceTool(item, 'item.completed', state);
  }

  // Only the update carrying `rawInput` matters before completion: the others
  // stream the arguments as partial JSON, which is neither input nor output.
  if (!('rawInput' in update)) return { events: [], state };
  const input = update.rawInput;
  const display = toolDisplay(previous.name, input);
  const item: UiToolItem = {
    ...previous,
    input,
    toolKind: toolKindFor(display.toolKind, update.kind),
    // Kimi's own descriptive title ("Reading list.txt") beats a generic one.
    title: string(update.title) ?? display.title,
  };
  const diffs = inputDiffs(previous.name, input);
  if (diffs) item.diffs = diffs;
  const mapped = replaceTool(item, 'item.updated', state);
  const plan = todoPlan(previous.name, input);
  if (!plan) return mapped;
  const planned = emitPlan(plan, mapped.state);
  return { events: [...mapped.events, ...planned.events], state: planned.state };
}

function emitPlan(entries: PlanEntry[], state: KimiUiMapperState): KimiUiMapping {
  const key = JSON.stringify(entries.map((entry) => [entry.content, entry.status]));
  if (key === state.planKey) return { events: [], state };
  return { events: [{ type: 'plan.updated', entries }], state: { ...state, planKey: key } };
}

function replaceTool(
  item: UiToolItem,
  type: 'item.updated' | 'item.completed',
  state: KimiUiMapperState,
): KimiUiMapping {
  const tools = new Map(state.tools);
  tools.set(item.id, item);
  return { events: [{ type, item }], state: { ...state, tools } };
}

/** The standard ACP `plan` update, should Kimi (or a future version) send one. */
function mapAcpPlan(update: Record<string, unknown>, state: KimiUiMapperState): KimiUiMapping {
  if (!Array.isArray(update.entries)) return { events: [], state };
  const entries: PlanEntry[] = [];
  for (const entry of update.entries) {
    if (!isRecord(entry)) continue;
    const content = string(entry.content);
    const status = planStatus(string(entry.status));
    if (!content || !status) continue;
    const priority = string(entry.priority);
    entries.push({
      content,
      status,
      ...(priority === 'high' || priority === 'medium' || priority === 'low' ? { priority } : {}),
    });
  }
  return emitPlan(entries, state);
}

function mapUsageRecord(value: Record<string, unknown>, state: KimiUiMapperState): KimiUiMapping {
  const usage = isRecord(value.usage) ? value.usage : undefined;
  if (!usage) return { events: [], state };
  const input = number(usage.inputOther) ?? 0;
  const output = number(usage.output) ?? 0;
  const cacheRead = number(usage.inputCacheRead) ?? 0;
  const cacheWrite = number(usage.inputCacheCreation) ?? 0;
  const prior = state.turnUsage;
  const summed: TokenUsage = {
    input: (prior?.input ?? 0) + input,
    output: (prior?.output ?? 0) + output,
    cacheRead: (prior?.cacheRead ?? 0) + cacheRead,
    cacheWrite: (prior?.cacheWrite ?? 0) + cacheWrite,
    total: 0,
    ...(state.contextWindow ? { contextWindow: state.contextWindow } : {}),
  };
  summed.total = summed.input + summed.output + (summed.cacheRead ?? 0) + (summed.cacheWrite ?? 0);
  if (summed.total <= 0) return { events: [], state };
  return { events: [{ type: 'usage.updated', usage: summed }], state: { ...state, turnUsage: summed } };
}

/**
 * A turn no `session/prompt` answer will ever end: Kimi died, or cezar stopped it, mid-prompt.
 * With a `message` it settles as an error answer would (`session.error`, then
 * `turn.completed{error}`); without one it settles with `stopReason` — `cancelled` for a stop
 * cezar asked for, `timeout` for the run's own deadline. The Kimi twin of `abortAcpTurn`.
 */
export function abortKimiTurn(state: KimiUiMapperState, stopReason: StopReason, message?: string): KimiUiMapping {
  if (!state.turnId) return closeOpen(state);
  return message === undefined ? completeTurn(stopReason, state) : completeTurn('error', state, message);
}

function completeTurn(reason: StopReason, state: KimiUiMapperState, errorMessage?: string): KimiUiMapping {
  const closed = closeOpen(state);
  if (!closed.state.turnId) return closed;
  const events = [...closed.events];
  let next = closed.state;
  // Tools a cancelled, failed or abandoned turn left running would spin forever: settle them.
  if (reason !== 'end_turn') {
    const tools = new Map(next.tools);
    for (const [id, tool] of next.tools) {
      if (tool.status !== 'pending' && tool.status !== 'running') continue;
      const item: UiToolItem = { ...tool, status: 'failed', error: `turn ended (${reason}) before the tool finished` };
      tools.set(id, item);
      events.push({ type: 'item.completed', item });
    }
    next = { ...next, tools };
  }
  if (errorMessage !== undefined) events.push({ type: 'session.error', message: errorMessage, fatal: false });
  const event: Extract<UiEvent, { type: 'turn.completed' }> = {
    type: 'turn.completed',
    turnId: next.turnId!,
    stopReason: reason,
  };
  if (next.turnUsage) event.usage = next.turnUsage;
  events.push(event);
  // Cleared with the turn: the next turn's counts are its own.
  return { events, state: { ...next, turnId: null, turnUsage: null } };
}

/** ACP stop reasons, onto the protocol's (they are nearly the same set). */
function acpStopReason(value: string): StopReason {
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

/** Our name-based kind wins; ACP's `kind` fills in for a tool we don't know. */
function toolKindFor(fromName: ToolKind, acpKind: unknown): ToolKind {
  if (fromName !== 'other') return fromName;
  switch (string(acpKind)) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'think':
    case 'fetch':
      return acpKind as ToolKind;
    default:
      return 'other';
  }
}

function inputDiffs(name: string, input: unknown): FileDiff[] | undefined {
  const lower = name.toLowerCase();
  if (!isRecord(input) || (lower !== 'edit' && lower !== 'write')) return undefined;
  const path = string(input.path) ?? string(input.file_path);
  if (!path) return undefined;
  const newText = string(input.new_string) ?? string(input.content);
  const oldText = string(input.old_string) ?? (lower === 'write' ? null : undefined);
  if (oldText === undefined && newText === undefined) return undefined;
  return [{ path, oldText: oldText ?? null, ...(newText !== undefined ? { newText } : {}) }];
}

/** ACP's own `diff` content parts, when a tool reports its change that way. */
function contentDiffs(content: unknown): FileDiff[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs: FileDiff[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'diff') continue;
    const path = string(part.path);
    if (!path) continue;
    const newText = string(part.newText);
    diffs.push({ path, oldText: string(part.oldText) ?? null, ...(newText !== undefined ? { newText } : {}) });
  }
  return diffs.length > 0 ? diffs : undefined;
}

/** Kimi's `TodoList` tool: `{todos: [{title, status}]}`, status `done` meaning completed. */
function todoPlan(name: string, input: unknown): PlanEntry[] | undefined {
  if (name.toLowerCase() !== 'todolist' || !isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo)) continue;
    const content = string(todo.title) ?? string(todo.content);
    const status = planStatus(string(todo.status));
    if (content && status) entries.push({ content, status });
  }
  return entries;
}

function planStatus(value: string | undefined): PlanEntry['status'] | undefined {
  switch (value) {
    case 'pending':
    case 'in_progress':
    case 'cancelled':
      return value;
    case 'completed':
    case 'done':
      return 'completed';
    default:
      return undefined;
  }
}

function currentModel(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((o) => isRecord(o) && o.id === 'model');
  return isRecord(option) ? string(option.currentValue) : undefined;
}

/** ACP content blocks: `[{type:'content', content:{type:'text', text}}]`. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'content' || !isRecord(part.content)) continue;
    const text = string(part.content.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
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

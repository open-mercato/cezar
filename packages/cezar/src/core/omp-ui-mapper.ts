/**
 * Pure omp RPC → normalized protocol-v2 mapper.
 *
 * `omp --mode rpc` is a newline-delimited JSON protocol over stdio — omp is
 * pi's continuation (Protocol reference: docs/rpc.md shipped with the CLI,
 * also at https://omp.sh/docs/rpc), so the wire shares pi's frame families
 * (`message_update` with an `assistantMessageEvent`, `tool_execution_*`) and
 * the pi mapper's rows carry over. Two omp additions the pi mapper never had:
 *
 *   - `toolcall_*` — the model's function call streamed INSIDE an assistant
 *     message (`toolcall_start`/`toolcall_delta`/`toolcall_end`). The end
 *     frame carries the complete tool call (`id`, `name`, `arguments`); the
 *     `tool_execution_*` frames that follow belong to the SAME tool item,
 *     keyed by `toolCallId`.
 *   - `prompt_result` — the terminal settle (pi's `agent_settled`): one per
 *     accepted prompt, with `status: completed | aborted | error`. Frames of
 *     older runtimes omit it; it can arrive before or after `agent_end`.
 *
 * `turn_start`/`turn_end` are per-model-round UI frames and are NOT mapped to
 * v2 turns: cezar's turn is one user prompt (the runner emits `turn.started`
 * when it writes the prompt), exactly like the other backends.
 *
 * Mapper robustness contract (AGENT_PROTOCOL.md §4): never throws; unparseable
 * input produces no events; state is explicit and immutable.
 */
import type {
  PlanEntry,
  StopReason,
  TokenUsage,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.js';
import { toolDisplay } from './tool-display.js';

export interface OmpUiMapperState {
  readonly sessionStarted: boolean;
  readonly sessionId: string | null;
  readonly turnSeq: number;
  readonly turnId: string | null;
  readonly stopReason: StopReason;
  /**
   * The usage omp reported across every assistant `message_end` of the turn
   * currently in flight, held until `prompt_result` (which carries none of
   * its own) ends the turn — without this the `turn.completed` event would
   * ship without the per-turn counts every other backend emits, a parity
   * capability (`ui-parity.test.ts`).
   */
  readonly turnUsage: TokenUsage | null;
  readonly turnCostUsd: number | null;
  /** Session-cumulative totals — omp's per-message `usage.updated` contract. */
  readonly sessionUsage: TokenUsage | null;
  readonly sessionCostUsd: number | null;
  readonly startedItems: ReadonlySet<string>;
  readonly textByItem: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, UiToolItem>;
}

export interface OmpUiMapping {
  events: UiEvent[];
  state: OmpUiMapperState;
}

export function createOmpUiState(): OmpUiMapperState {
  return {
    sessionStarted: false,
    sessionId: null,
    turnSeq: 0,
    turnId: null,
    stopReason: 'end_turn',
    turnUsage: null,
    turnCostUsd: null,
    sessionUsage: null,
    sessionCostUsd: null,
    startedItems: new Set(),
    textByItem: new Map(),
    tools: new Map(),
  };
}

/** The runner calls this when it writes a `prompt` command — one v2 turn per prompt. */
export function ompTurnStarted(state: OmpUiMapperState): OmpUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: { ...state, turnSeq, turnId, stopReason: 'end_turn' },
  };
}

export function mapOmpRpcMessage(value: unknown, state: OmpUiMapperState): OmpUiMapping {
  if (!isRecord(value) || typeof value.type !== 'string') return { events: [], state };

  if (value.type === 'response') {
    if (value.command === 'get_state' && value.success === true && isRecord(value.data)) {
      const sessionId = string(value.data.sessionId);
      if (sessionId && !state.sessionStarted) {
        const model = isRecord(value.data.model) ? string(value.data.model.id) : undefined;
        return {
          events: [{ type: 'session.started', sessionId, backend: 'omp', ...(model ? { model } : {}) }],
          state: { ...state, sessionStarted: true, sessionId },
        };
      }
    }
    if (value.success === false) {
      return {
        events: [{ type: 'session.error', message: rpcError(value), fatal: false }],
        state,
      };
    }
    return { events: [], state };
  }

  switch (value.type) {
    case 'message_update':
      return mapMessageUpdate(value, state);
    case 'message_end':
      return mapMessageEnd(value, state);
    case 'tool_execution_start':
      return mapToolStart(value, state);
    case 'tool_execution_update':
      return mapToolUpdate(value, state);
    case 'tool_stream_update':
      return mapToolStream(value, state);
    case 'tool_execution_end':
      return mapToolEnd(value, state);
    case 'prompt_result':
      return mapPromptResult(value, state);
    case 'extension_error': {
      const message = string(value.error) ?? string(value.message) ?? 'omp extension error';
      return { events: [{ type: 'session.error', message, fatal: false }], state };
    }
    default:
      return { events: [], state };
  }
}

function mapMessageUpdate(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const update = isRecord(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
  const updateType = update ? string(update.type) : undefined;
  if (!update || !updateType) return { events: [], state };

  // `messageId` is stable per assistant message; contentIndex disambiguates the
  // thinking/toolcall/text blocks inside one message. Fall back to the turn id
  // when a frame lacks a messageId (older runtimes).
  const messageId = string(value.messageId) ?? state.turnId;
  if (!messageId) return { events: [], state };
  const contentIndex = number(update.contentIndex) ?? 0;

  const field =
    updateType.startsWith('thinking_') ? ('reasoning' as const) : updateType.startsWith('text_') ? ('text' as const) : null;
  if (field) {
    return mapContentDeltas(updateType, field, messageId, contentIndex, update, state);
  }
  if (updateType === 'toolcall_end') {
    return mapToolcallEnd(update, state);
  }
  return { events: [], state };
}

/** `thinking_*` → reasoning item, `text_*` → message item: started, streamed, completed. */
function mapContentDeltas(
  updateType: string,
  field: 'reasoning' | 'text',
  messageId: string,
  contentIndex: number,
  update: Record<string, unknown>,
  state: OmpUiMapperState,
): OmpUiMapping {
  const itemId = `${messageId}_${field}_${contentIndex}`;
  const events: UiEvent[] = [];
  let startedItems = state.startedItems;
  let textByItem = state.textByItem;
  const makeItem = (text: string): UiMessageItem | UiReasoningItem =>
    field === 'text'
      ? { kind: 'message', id: itemId, role: 'assistant', text }
      : { kind: 'reasoning', id: itemId, text };

  if (!startedItems.has(itemId)) {
    events.push({ type: 'item.started', item: makeItem('') });
    startedItems = new Set(startedItems).add(itemId);
  }

  const delta = string(update.delta);
  if (delta !== undefined) {
    events.push({ type: 'item.delta', itemId, field, delta });
    const next = new Map(textByItem);
    next.set(itemId, `${next.get(itemId) ?? ''}${delta}`);
    textByItem = next;
  }

  if (updateType.endsWith('_end')) {
    const text = string(update.content) ?? textByItem.get(itemId) ?? '';
    events.push({ type: 'item.completed', item: makeItem(text) });
  }
  return { events, state: { ...state, startedItems, textByItem } };
}

/** `toolcall_end` carries the model's complete function call — start the tool item pending. */
function mapToolcallEnd(update: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : undefined;
  if (!toolCall) return { events: [], state };
  const id = string(toolCall.id);
  const name = string(toolCall.name);
  if (!id || !name) return { events: [], state };
  if (state.tools.has(id)) return { events: [], state };

  const input = toolCall.arguments;
  const display = toolDisplay(name, input);
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name,
    toolKind: display.toolKind,
    title: display.title,
    status: 'pending',
    input,
  };
  const diffs = toolDiffs(name, input);
  if (diffs) item.diffs = diffs;
  const tools = new Map(state.tools);
  tools.set(id, item);
  const events: UiEvent[] = [{ type: 'item.started', item }];
  const plan = toolCallPlan(name, input);
  if (plan) events.push({ type: 'plan.updated', entries: plan });
  return { events, state: { ...state, tools } };
}

/** `tool_execution_start` — the tool is actually running, with its REAL args. */
function mapToolStart(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const id = string(value.toolCallId);
  const name = string(value.toolName);
  if (!id || !name) return { events: [], state };
  const previous = state.tools.get(id);
  const input = value.args;
  const display = toolDisplay(name, input);
  const item: UiToolItem = previous
    ? { ...previous, status: 'running', input }
    : {
        kind: 'tool',
        id,
        name,
        toolKind: display.toolKind,
        title: display.title,
        status: 'running',
        input,
      };
  const tools = new Map(state.tools);
  tools.set(id, item);
  const events: UiEvent[] = previous
    ? [{ type: 'item.updated', item }]
    : [{ type: 'item.started', item }];
  return { events, state: { ...state, tools } };
}

/** Live terminal/progress text while the tool runs. */
function mapToolUpdate(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const id = string(value.toolCallId);
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const output = contentText(isRecord(value.partialResult) ? value.partialResult.content : undefined);
  if (output === undefined) return { events: [], state };
  const item: UiToolItem = { ...previous, output };
  const tools = new Map(state.tools);
  tools.set(id, item);
  return { events: [{ type: 'item.updated', item }], state: { ...state, tools } };
}

/** Streaming edit diffs (`update.files[].diff` is a unified diff). */
function mapToolStream(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const id = string(value.toolCallId);
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const update = isRecord(value.update) ? value.update : undefined;
  const files = Array.isArray(update?.files) ? update.files : [];
  // Merge, never replace: `toolcall_end` already derived an old/new-text diff from the call's
  // arguments, so a streamed entry ADDS its unified line-diff to that path, and an entry with a
  // bare `path` and no diff adds nothing — it must not erase what the item already shows.
  const diffs = [...(previous.diffs ?? [])];
  let changed = false;
  for (const file of files) {
    if (!isRecord(file)) continue;
    const path = string(file.path);
    const unified = string(file.diff);
    if (!path || !unified) continue;
    const index = diffs.findIndex((diff) => diff.path === path);
    // Streamed line-diffs carry no before-text; `oldText: null` is the "newly
    // created / no comparison base" spelling of the FileDiff contract.
    if (index === -1) diffs.push({ path, oldText: null, unified });
    else diffs[index] = { ...diffs[index]!, unified };
    changed = true;
  }
  if (!changed) return { events: [], state };
  const item: UiToolItem = { ...previous, diffs };
  const tools = new Map(state.tools);
  tools.set(id, item);
  return { events: [{ type: 'item.updated', item }], state: { ...state, tools } };
}

/** `tool_execution_end` — completed/failed, plus the todo tool's full plan snapshot. */
function mapToolEnd(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const id = string(value.toolCallId);
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const result = isRecord(value.result) ? value.result : {};
  const details = isRecord(result.details) ? result.details : {};
  // A result without text keeps whatever the pending item already showed.
  const output = contentText(result.content) ?? previous.output;
  const isError = value.isError === true;
  const exitCode = number(details.exitCode);
  const item: UiToolItem = {
    ...previous,
    status: isError ? 'failed' : 'completed',
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(isError ? { error: output ?? 'omp tool failed' } : output !== undefined ? { output } : {}),
  };
  const tools = new Map(state.tools);
  tools.set(id, item);
  const events: UiEvent[] = [{ type: 'item.completed', item }];
  const plan = toolResultPlan(previous.name, result);
  if (plan) events.push({ type: 'plan.updated', entries: plan });
  return { events, state: { ...state, tools } };
}

/** `prompt_result` ends the turn pi used to end with `agent_settled`. */
function mapPromptResult(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  if (!state.turnId) return { events: [], state };
  // `agentInvoked: false` means a slash command finished locally — no agent ran, but the runner
  // did open this turn when it sent the prompt, so it is closed here: every `turn.started` gets
  // its `turn.completed` (the v1 stream already recovers via `turn-end`), with no usage to report.
  if (value.agentInvoked === false) {
    return {
      events: [{ type: 'turn.completed', turnId: state.turnId, stopReason: 'end_turn' }],
      state: { ...state, turnId: null, turnUsage: null, turnCostUsd: null },
    };
  }
  const status = string(value.status);
  const reason: StopReason =
    status === 'aborted' ? 'cancelled' : status === 'error' ? 'error' : status === 'completed' ? 'end_turn' : 'end_turn';
  const event: Extract<UiEvent, { type: 'turn.completed' }> = {
    type: 'turn.completed',
    turnId: state.turnId,
    stopReason: reason,
  };
  if (state.turnUsage) event.usage = state.turnUsage;
  if (state.turnCostUsd !== null) event.costUsd = state.turnCostUsd;
  const events: UiEvent[] = [
    event,
    ...(reason === 'error' ? [{ type: 'session.error' as const, message: promptError(value), fatal: false as const }] : []),
  ];
  // Cleared with the turn id: the next turn's counts are its own, and a turn
  // omp ends without reporting usage must not inherit the previous turn's.
  return { events, state: { ...state, turnId: null, turnUsage: null, turnCostUsd: null } };
}

/** Assistant `message_end` carries the usage of THAT message — omp's `totalTokens` equals its
 *  own input+output+cacheRead. Accumulate: `usage.updated` reports session-cumulative totals
 *  (the v2 contract) and the turn's running sum feeds `turn.completed`. */
function mapMessageEnd(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const message = isRecord(value.message) ? value.message : undefined;
  if (!message || message.role !== 'assistant') return { events: [], state };
  const usage = usageEvent(message.usage);
  if (!usage) return { events: [], state };
  const sessionUsage = sumUsage(state.sessionUsage, usage.usage);
  const turnUsage = sumUsage(state.turnUsage, usage.usage);
  const usageUpdatedEvent: Extract<UiEvent, { type: 'usage.updated' }> = {
    type: 'usage.updated',
    usage: sessionUsage,
    ...(usage.costUsd !== undefined
      ? { costUsd: (state.sessionCostUsd ?? 0) + usage.costUsd }
      : {}),
  };
  return {
    events: [usageUpdatedEvent],
    state: {
      ...state,
      turnUsage,
      turnCostUsd: state.turnCostUsd === null ? usage.costUsd ?? null : (state.turnCostUsd ?? 0) + (usage.costUsd ?? 0),
      sessionUsage,
      sessionCostUsd: (state.sessionCostUsd ?? 0) + (usage.costUsd ?? 0),
    },
  };
}

function sumUsage(previous: TokenUsage | null, next: TokenUsage): TokenUsage {
  if (!previous) return next;
  return {
    input: previous.input + next.input,
    output: previous.output + next.output,
    total: previous.total + next.total,
    ...(previous.cacheRead !== undefined || next.cacheRead !== undefined
      ? { cacheRead: (previous.cacheRead ?? 0) + (next.cacheRead ?? 0) }
      : {}),
    ...(previous.cacheWrite !== undefined || next.cacheWrite !== undefined
      ? { cacheWrite: (previous.cacheWrite ?? 0) + (next.cacheWrite ?? 0) }
      : {}),
  };
}

/**
 * The todo tool reports the authoritative phase list in its result details —
 * a FULL replacement, exactly ACP plan semantics. Statuses are omp's
 * TodoItem statuses, mapped onto the v2 PlanStatus vocabulary.
 */
function toolResultPlan(name: string | undefined, result: Record<string, unknown>): PlanEntry[] | undefined {
  if (!name || name.toLowerCase() !== 'todo') return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  const phases = Array.isArray(details?.phases) ? details.phases : undefined;
  if (!phases) return undefined;
  const entries: PlanEntry[] = [];
  for (const phase of phases) {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) continue;
    for (const task of phase.tasks) {
      if (!isRecord(task)) continue;
      const content = string(task.content);
      const mapped = planStatus(string(task.status));
      if (!content || !mapped) continue;
      entries.push({ content, status: mapped });
    }
  }
  return entries.length > 0 ? entries : undefined;
}

function planStatus(status: string | undefined): PlanEntry['status'] | undefined {
  switch (status) {
    case 'completed':
      return 'completed';
    // An abandoned phase was dropped, not finished — the plan dock has a word for that.
    case 'abandoned':
      return 'cancelled';
    case 'in_progress':
      return 'in_progress';
    case 'pending':
    case 'blocked':
      return 'pending';
    default:
      return undefined;
  }
}

/** A `todo` `init` call's args already name the entries, all pending. */
function toolCallPlan(name: string | undefined, input: unknown): PlanEntry[] | undefined {
  if (!name || name.toLowerCase() !== 'todo' || !isRecord(input)) return undefined;
  const entries: PlanEntry[] = [];
  const list = Array.isArray(input.list) ? input.list : undefined;
  if (list) {
    for (const phase of list) {
      if (!isRecord(phase) || !Array.isArray(phase.items)) continue;
      for (const item of phase.items) {
        const content = string(item);
        if (content) entries.push({ content, status: 'pending' });
      }
    }
  } else if (Array.isArray(input.items)) {
    for (const item of input.items) {
      const content = string(item);
      if (content) entries.push({ content, status: 'pending' });
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/** Edit/write tool calls carry their diff in the arguments (pi's shape, reused verbatim). */
function toolDiffs(name: string | undefined, input: unknown): UiToolItem['diffs'] | undefined {
  if (!name || !isRecord(input) || !['edit', 'write'].includes(name.toLowerCase())) return undefined;
  const path = string(input.path) ?? string(input.file_path) ?? string(input.filePath);
  if (!path) return undefined;
  const oldText = string(input.oldText) ?? string(input.old_string) ?? (name.toLowerCase() === 'write' ? null : undefined);
  const newText = string(input.newText) ?? string(input.new_string) ?? string(input.content);
  if (oldText === undefined && newText === undefined) return undefined;
  return [{ path, oldText: oldText ?? null, ...(newText !== undefined ? { newText } : {}) }];
}

function usageEvent(value: unknown): Extract<UiEvent, { type: 'usage.updated' }> | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead);
  const cacheWrite = number(value.cacheWrite);
  const total = number(value.totalTokens) ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (total <= 0) return undefined;
  const cost = isRecord(value.cost) ? number(value.cost.total) : undefined;
  return {
    type: 'usage.updated',
    usage: {
      input,
      output,
      total,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

function rpcError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return (
    string(error?.message) ??
    string(value.error) ??
    string(value.message) ??
    `omp RPC command ${string(value.command) ?? 'unknown'} failed`
  );
}

function promptError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? 'omp turn failed';
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
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

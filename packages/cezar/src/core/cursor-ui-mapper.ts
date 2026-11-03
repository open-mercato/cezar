/**
 * Cursor Agent CLI `stream-json` → protocol v2 mapper (+ v1 helpers).
 *
 * Wire shapes: https://cursor.com/docs/cli/reference/output-format
 * (`system/init`, `assistant`, `tool_call` started/completed, `result`).
 *
 * Per the docs above, `thinking` events are suppressed in print mode and the
 * terminal `result` frame carries no `usage`/`total_cost_usd` — reasoning and
 * usage.updated/turn.completed-usage are therefore documented `except`
 * exclusions in `ui-parity.test.ts` (AGENT_PROTOCOL.md §6), not capabilities
 * this mapper produces. The `usage`/`total_cost_usd` reads below are kept as a
 * defensive no-op against real output, per the docs' own "field additions may
 * occur… backward-compatible" note — see `cursor-ui-mapper.test.ts`'s header
 * for the full verified-vs-unverified provenance split.
 *
 * Never throws on malformed input. State is immutable — callers thread the
 * returned `state` into the next call.
 */

import type { AgentEvent } from './agent-runner.ts';
import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  StopReason,
  TokenUsage,
  ToolLocation,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiSessionStartedEvent,
  UiToolItem,
  UiTurnCompletedEvent,
  UiUsageUpdatedEvent,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

// ---- v2 state ---------------------------------------------------------------

export interface CursorUiMapperState {
  readonly fallbackSessionId?: string;
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  readonly itemSeq: number;
  readonly sawAssistantText: boolean;
  readonly openTools: ReadonlyMap<string, UiToolItem>;
}

export interface CursorUiMapping {
  events: UiEvent[];
  state: CursorUiMapperState;
}

export function createCursorUiState(opts: { fallbackSessionId?: string } = {}): CursorUiMapperState {
  return {
    fallbackSessionId: opts.fallbackSessionId,
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    itemSeq: 0,
    sawAssistantText: false,
    openTools: new Map(),
  };
}

/** Fold one parsed stream-json line into v2 events. Never throws. */
export function mapCursorMessage(msg: unknown, state: CursorUiMapperState): CursorUiMapping {
  try {
    if (!isRecord(msg)) return { events: [], state };
    switch (msg.type) {
      case 'system':
        return msg.subtype === 'init' ? mapInit(msg, state) : { events: [], state };
      case 'assistant':
        return mapAssistant(msg, state);
      case 'tool_call':
        return mapToolCall(msg, state);
      case 'result':
        return mapResult(msg, state);
      default:
        return { events: [], state };
    }
  } catch {
    return { events: [], state };
  }
}

function mapInit(msg: Record<string, unknown>, state: CursorUiMapperState): CursorUiMapping {
  const sessionId = str(msg.session_id) ?? state.fallbackSessionId ?? '';
  const event: UiSessionStartedEvent = {
    type: 'session.started',
    sessionId,
    backend: 'cursor',
  };
  const model = str(msg.model);
  if (model !== undefined) event.model = model;
  const cwd = str(msg.cwd);
  if (cwd !== undefined) event.cwd = cwd;

  // Print mode has no stdin turn boundary — start turn_1 with the session.
  const turnId = `turn_${state.turnSeq + 1}`;
  return {
    events: [event, { type: 'turn.started', turnId }],
    state: {
      ...state,
      sessionStarted: true,
      turnSeq: state.turnSeq + 1,
      currentTurnId: turnId,
    },
  };
}

function mapAssistant(msg: Record<string, unknown>, state: CursorUiMapperState): CursorUiMapping {
  // Skip partial-stream duplicates (docs: timestamp_ms + model_call_id table).
  if ('model_call_id' in msg) return { events: [], state };

  const content = messageContent(msg);
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let sawAssistantText = state.sawAssistantText;

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'text' && typeof raw.text === 'string' && raw.text) {
      sawAssistantText = true;
      const item: UiMessageItem = { kind: 'message', id: `item_${++itemSeq}`, role: 'assistant', text: raw.text };
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
    } else if (raw.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking.trim() !== '') {
      // Print mode suppresses dedicated thinking events; content-block thinking
      // is the documented substitute when a model still emits it.
      const item: UiReasoningItem = { kind: 'reasoning', id: `item_${++itemSeq}`, text: raw.thinking };
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
    }
  }

  if (events.length === 0) return { events, state };
  return { events, state: { ...state, itemSeq, sawAssistantText } };
}

function mapToolCall(msg: Record<string, unknown>, state: CursorUiMapperState): CursorUiMapping {
  const callId = str(msg.call_id);
  if (!callId) return { events: [], state };
  const subtype = str(msg.subtype);
  const parsed = parseCursorToolCall(msg.tool_call);

  if (subtype === 'started') {
    const display = toolDisplay(parsed.name, parsed.input);
    const item: UiToolItem = {
      kind: 'tool',
      id: callId,
      name: parsed.name,
      toolKind: display.toolKind,
      title: display.title,
      status: 'running',
    };
    if (parsed.input !== undefined) item.input = parsed.input;
    const edit = editArtifacts(parsed.name, parsed.input);
    if (edit) {
      if (edit.diffs) item.diffs = edit.diffs;
      item.locations = edit.locations;
    }
    const events: UiEvent[] = [{ type: 'item.started', item }];
    if (parsed.name === 'TodoWrite') {
      const entries = planEntries(parsed.input);
      if (entries) events.push({ type: 'plan.updated', entries });
    }
    const openTools = new Map(state.openTools);
    openTools.set(callId, item);
    return { events, state: { ...state, openTools } };
  }

  if (subtype === 'completed') {
    const open = state.openTools.get(callId);
    if (!open) return { events: [], state };
    const failed = toolFailed(parsed);
    const item: UiToolItem = {
      ...open,
      status: failed ? 'failed' : 'completed',
    };
    const output = toolOutput(parsed);
    if (output !== undefined) item.output = output;
    if (failed) {
      const err = toolErrorMessage(parsed);
      if (err) item.error = err;
    }
    // Prefer completed-side diffs (editToolCall.result.success.diffString).
    const completedDiffs = completedEditDiffs(parsed);
    if (completedDiffs) {
      item.diffs = completedDiffs.diffs;
      item.locations = completedDiffs.locations;
    }
    const openTools = new Map(state.openTools);
    openTools.delete(callId);
    return {
      events: [{ type: 'item.completed', item }],
      state: { ...state, openTools },
    };
  }

  return { events: [], state };
}

function mapResult(msg: Record<string, unknown>, state: CursorUiMapperState): CursorUiMapping {
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let sawAssistantText = state.sawAssistantText;

  // A tool that never got a `completed` tool_call event before the turn ended
  // (the turn was interrupted or errored) would otherwise stay "running"
  // forever in the UI — give it a terminal snapshot now.
  for (const open of state.openTools.values()) {
    events.push({ type: 'item.completed', item: { ...open, status: 'failed' } });
  }

  // If no assistant text streamed, surface the terminal result string once.
  if (!sawAssistantText && typeof msg.result === 'string' && msg.result.trim() !== '' && msg.is_error !== true) {
    sawAssistantText = true;
    const item: UiMessageItem = {
      kind: 'message',
      id: `item_${++itemSeq}`,
      role: 'assistant',
      text: msg.result,
    };
    events.push({ type: 'item.started', item }, { type: 'item.completed', item });
  }

  const turnId = state.currentTurnId ?? `turn_${Math.max(1, state.turnSeq)}`;
  const turnEvent: UiTurnCompletedEvent = {
    type: 'turn.completed',
    turnId,
    stopReason: resultStopReason(msg),
  };
  const usage = tokenUsage(msg);
  if (usage) turnEvent.usage = usage;
  if (typeof msg.total_cost_usd === 'number') turnEvent.costUsd = msg.total_cost_usd;
  events.push(turnEvent);

  if (usage) {
    const usageEvent: UiUsageUpdatedEvent = { type: 'usage.updated', usage };
    if (typeof msg.total_cost_usd === 'number') usageEvent.costUsd = msg.total_cost_usd;
    events.push(usageEvent);
  }

  return {
    events,
    state: {
      ...state,
      itemSeq,
      sawAssistantText,
      currentTurnId: null,
      openTools: new Map(),
    },
  };
}

function resultStopReason(msg: Record<string, unknown>): StopReason {
  if (msg.is_error === true) return 'error';
  if (msg.subtype === 'error_max_turns') return 'max_tokens';
  return 'end_turn';
}

function tokenUsage(msg: Record<string, unknown>): TokenUsage | undefined {
  if (!isRecord(msg.usage)) return undefined;
  const input = num(msg.usage.input_tokens) ?? 0;
  const output = num(msg.usage.output_tokens) ?? 0;
  const cacheRead = num(msg.usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = num(msg.usage.cache_creation_input_tokens) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) return undefined;
  const usage: TokenUsage = { input, output, total };
  if (cacheRead > 0) usage.cacheRead = cacheRead;
  if (cacheWrite > 0) usage.cacheWrite = cacheWrite;
  return usage;
}

// ---- tool_call parsing ------------------------------------------------------

interface ParsedTool {
  name: string;
  input: unknown;
  result?: unknown;
  rawKey?: string;
}

function parseCursorToolCall(toolCall: unknown): ParsedTool {
  if (!isRecord(toolCall)) return { name: 'tool', input: {} };

  if (isRecord(toolCall.function)) {
    const name = typeof toolCall.function.name === 'string' ? toolCall.function.name : 'function';
    let input: unknown = toolCall.function.arguments ?? toolCall.function.args ?? {};
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = { raw: input };
      }
    }
    return { name, input, result: toolCall.function.result, rawKey: 'function' };
  }

  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith('ToolCall') || !isRecord(value)) continue;
    const name = cursorToolKeyToName(key);
    return {
      name,
      input: value.args ?? {},
      result: value.result,
      rawKey: key,
    };
  }

  return { name: 'tool', input: toolCall };
}

function cursorToolKeyToName(key: string): string {
  const base = key.replace(/ToolCall$/, '');
  switch (base) {
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'shell':
      return 'Bash';
    case 'ls':
      return 'Ls';
    case 'grep':
      return 'Grep';
    case 'task':
      return 'Task';
    default:
      return base.charAt(0).toUpperCase() + base.slice(1);
  }
}

function editArtifacts(
  name: string,
  input: unknown,
): { diffs?: FileDiff[]; locations: ToolLocation[] } | undefined {
  const key = name.toLowerCase();
  if (key !== 'edit' && key !== 'write') return undefined;
  if (!isRecord(input)) return undefined;
  const path =
    (typeof input.path === 'string' && input.path) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.filePath === 'string' && input.filePath) ||
    '';
  if (!path) return undefined;
  const locations: ToolLocation[] = [{ path }];
  if (key === 'edit') {
    const oldText =
      typeof input.old_string === 'string'
        ? input.old_string
        : typeof input.oldString === 'string'
          ? input.oldString
          : null;
    const newText =
      typeof input.new_string === 'string'
        ? input.new_string
        : typeof input.newString === 'string'
          ? input.newString
          : typeof input.fileText === 'string'
            ? input.fileText
            : undefined;
    if (oldText !== null || newText !== undefined) {
      return { diffs: [{ path, oldText, newText }], locations };
    }
    return { locations };
  }
  const diff: FileDiff = { path, oldText: null };
  if (typeof input.fileText === 'string') diff.newText = input.fileText;
  else if (typeof input.content === 'string') diff.newText = input.content;
  return { diffs: [diff], locations };
}

function completedEditDiffs(parsed: ParsedTool): { diffs: FileDiff[]; locations: ToolLocation[] } | undefined {
  const key = parsed.name.toLowerCase();
  if (key !== 'edit' && key !== 'write') return undefined;
  if (!isRecord(parsed.input)) return undefined;
  const path =
    (typeof parsed.input.path === 'string' && parsed.input.path) ||
    (typeof parsed.input.file_path === 'string' && parsed.input.file_path) ||
    '';
  if (!path || !isRecord(parsed.result) || !isRecord(parsed.result.success)) return undefined;
  const success = parsed.result.success;
  const oldText =
    key === 'edit'
      ? typeof parsed.input.old_string === 'string'
        ? parsed.input.old_string
        : typeof parsed.input.oldString === 'string'
          ? parsed.input.oldString
          : null
      : null;
  const diff: FileDiff = { path, oldText };
  if (typeof success.afterFullFileContent === 'string') diff.newText = success.afterFullFileContent;
  else if (typeof success.diffString === 'string') diff.unified = success.diffString;
  else if (typeof parsed.input.fileText === 'string') diff.newText = parsed.input.fileText;
  else return undefined;
  if (typeof success.diffString === 'string') diff.unified = success.diffString;
  return { diffs: [diff], locations: [{ path }] };
}

function toolFailed(parsed: ParsedTool): boolean {
  if (!isRecord(parsed.result)) return false;
  if (isRecord(parsed.result.error)) return true;
  if (isRecord(parsed.result.success) && typeof parsed.result.success.exitCode === 'number') {
    return parsed.result.success.exitCode !== 0;
  }
  return false;
}

function toolErrorMessage(parsed: ParsedTool): string | undefined {
  if (!isRecord(parsed.result)) return undefined;
  if (isRecord(parsed.result.error) && typeof parsed.result.error.errorMessage === 'string') {
    return parsed.result.error.errorMessage;
  }
  if (isRecord(parsed.result.success)) {
    const stderr = parsed.result.success.stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  }
  return undefined;
}

function toolOutput(parsed: ParsedTool): string | undefined {
  if (!isRecord(parsed.result)) return undefined;
  if (isRecord(parsed.result.success)) {
    const s = parsed.result.success;
    if (typeof s.stdout === 'string') return s.stdout;
    if (typeof s.content === 'string') return s.content;
    if (typeof s.resultForModel === 'string') return s.resultForModel;
  }
  try {
    return JSON.stringify(parsed.result);
  } catch {
    return undefined;
  }
}

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

function planEntries(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') continue;
    const status = PLAN_STATUSES.find((s) => s === todo.status) ?? 'pending';
    const entry: PlanEntry = { content: todo.content, status };
    if (typeof todo.activeForm === 'string') entry.activeForm = todo.activeForm;
    entries.push(entry);
  }
  return entries;
}

// ---- shared helpers ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function messageContent(msg: Record<string, unknown>): unknown[] {
  if (!isRecord(msg.message) || !Array.isArray(msg.message.content)) return [];
  return msg.message.content;
}

// ---- v1 AgentEvent mapping (unchanged contract for runners / dry-run) -------

function toolNameFromCall(toolCall: unknown): string {
  return parseCursorToolCall(toolCall).name;
}

function toolInputFromCall(toolCall: unknown): unknown {
  return parseCursorToolCall(toolCall).input;
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Convert one Cursor stream-json object into zero or more v1 AgentEvents.
 * With default (non-partial) stream-json, every assistant event is used.
 */
export function mapCursorStreamEvent(raw: unknown): AgentEvent[] {
  if (!isRecord(raw)) return [];
  const type = raw.type;

  try {
    if (type === 'system' && raw.subtype === 'init' && typeof raw.session_id === 'string') {
      return [{ type: 'session', sessionId: raw.session_id }];
    }

    if (type === 'assistant') {
      if ('model_call_id' in raw) return [];
      const text = assistantText(raw.message);
      return text ? [{ type: 'text', text }] : [];
    }

    if (type === 'tool_call') {
      const callId = typeof raw.call_id === 'string' ? raw.call_id : `cursor-${Date.now()}`;
      if (raw.subtype === 'started') {
        return [
          {
            type: 'tool-call',
            id: callId,
            tool: toolNameFromCall(raw.tool_call),
            input: toolInputFromCall(raw.tool_call),
          },
        ];
      }
      if (raw.subtype === 'completed') {
        const parsed = parseCursorToolCall(raw.tool_call);
        return [
          {
            type: 'tool-result',
            toolCallId: callId,
            result: JSON.stringify(parsed.result ?? {}),
            isError: toolFailed(parsed),
          },
        ];
      }
      return [];
    }

    if (type === 'result') {
      // `session` and `done` are owned by the runner (init emits session once; the runner's
      // own post-loop logic emits exactly one terminal `done`) — emitting them here too
      // produced duplicate events in the append-only run log.
      const events: AgentEvent[] = [];
      // Cursor's documented terminal `result` shape is
      // {type, subtype, is_error, duration_ms, duration_api_ms, result, session_id, request_id}
      // — no `usage`/`total_cost_usd` field today. Kept defensive per the docs' own "field
      // additions may occur… backward-compatible" note; harmless no-op against real output.
      const usage = tokenUsage(raw);
      if (usage) events.push({ type: 'token-usage', tokensUsed: usage.total });
      if (typeof raw.total_cost_usd === 'number' && raw.total_cost_usd > 0) {
        events.push({ type: 'cost', usd: raw.total_cost_usd });
      }
      if (raw.is_error === true) {
        const msg =
          typeof raw.result === 'string' && raw.result
            ? raw.result
            : 'Cursor agent reported an error';
        events.push({ type: 'error', message: msg });
      }
      events.push({ type: 'turn-end' });
      return events;
    }

    return [];
  } catch {
    return [];
  }
}

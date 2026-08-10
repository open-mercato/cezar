/**
 * Pure pi RPC → normalized protocol-v2 mapper.
 *
 * Contract: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
 * Unknown or malformed wire data is ignored; this mapper never throws.
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

export interface PiUiMapperState {
  readonly sessionStarted: boolean;
  readonly sessionId: string | null;
  readonly turnSeq: number;
  readonly turnId: string | null;
  readonly stopReason: StopReason;
  /**
   * The usage pi reported for the turn currently in flight, held between `message_end` (which
   * carries it) and `agent_settled` (which ends the turn).
   *
   * pi splits the two the way claude does not: its terminal frame has no usage of its own, so
   * without this the `turn.completed` event would ship without the per-turn directional counts
   * every other backend emits — a parity capability, not a nicety (`ui-parity.test.ts`).
   */
  readonly turnUsage: TokenUsage | null;
  readonly turnCostUsd: number | null;
  readonly startedItems: ReadonlySet<string>;
  readonly textByItem: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, UiToolItem>;
}

export interface PiUiMapping {
  events: UiEvent[];
  state: PiUiMapperState;
}

export function createPiUiState(): PiUiMapperState {
  return {
    sessionStarted: false,
    sessionId: null,
    turnSeq: 0,
    turnId: null,
    stopReason: 'end_turn',
    turnUsage: null,
    turnCostUsd: null,
    startedItems: new Set(),
    textByItem: new Map(),
    tools: new Map(),
  };
}

export function piTurnStarted(state: PiUiMapperState): PiUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: { ...state, turnSeq, turnId, stopReason: 'end_turn' },
  };
}

export function mapPiRpcMessage(value: unknown, state: PiUiMapperState): PiUiMapping {
  if (!isRecord(value) || typeof value.type !== 'string') return { events: [], state };

  if (value.type === 'response') {
    if (value.command === 'get_state' && value.success === true && isRecord(value.data)) {
      const sessionId = string(value.data.sessionId);
      if (sessionId && !state.sessionStarted) {
        const model = isRecord(value.data.model) ? string(value.data.model.id) : undefined;
        return {
          events: [{ type: 'session.started', sessionId, backend: 'pi', ...(model ? { model } : {}) }],
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
    case 'tool_execution_end':
      return mapToolEnd(value, state);
    case 'agent_settled':
      return completeTurn(state.stopReason, state);
    case 'extension_error': {
      const message = string(value.error) ?? string(value.message) ?? 'pi extension error';
      return { events: [{ type: 'session.error', message, fatal: false }], state };
    }
    default:
      return { events: [], state };
  }
}

function mapMessageUpdate(value: Record<string, unknown>, state: PiUiMapperState): PiUiMapping {
  const update = isRecord(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
  const updateType = update ? string(update.type) : undefined;
  const contentIndex = update ? number(update.contentIndex) ?? 0 : 0;
  if (!update || !updateType || !state.turnId) return { events: [], state };

  if (updateType === 'done') {
    return {
      events: [],
      state: { ...state, stopReason: string(update.reason) === 'length' ? 'max_tokens' : 'end_turn' },
    };
  }
  if (updateType === 'error') {
    const reason: StopReason = string(update.reason) === 'aborted' ? 'cancelled' : 'error';
    const error = isRecord(update.error) ? string(update.error.errorMessage) : undefined;
    return {
      events: [{ type: 'session.error', message: error ?? `pi model ${reason}`, fatal: false }],
      state: { ...state, stopReason: reason },
    };
  }

  const field =
    updateType.startsWith('thinking_') ? ('reasoning' as const) : updateType.startsWith('text_') ? ('text' as const) : null;
  if (!field) return { events: [], state };

  const itemId = `${state.turnId}_${field}_${contentIndex}`;
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

function mapToolStart(value: Record<string, unknown>, state: PiUiMapperState): PiUiMapping {
  const id = string(value.toolCallId);
  const name = string(value.toolName);
  if (!id || !name) return { events: [], state };
  const display = toolDisplay(name, value.args);
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name,
    toolKind: display.toolKind,
    title: display.title,
    status: 'running',
    input: value.args,
  };
  const diffs = toolDiffs(name, value.args);
  if (diffs) item.diffs = diffs;
  const tools = new Map(state.tools);
  tools.set(id, item);
  const events: UiEvent[] = [{ type: 'item.started', item }];
  const plan = toolPlan(name, value.args);
  if (plan) events.push({ type: 'plan.updated', entries: plan });
  return { events, state: { ...state, tools } };
}

function mapToolUpdate(value: Record<string, unknown>, state: PiUiMapperState): PiUiMapping {
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

function mapToolEnd(value: Record<string, unknown>, state: PiUiMapperState): PiUiMapping {
  const id = string(value.toolCallId);
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const result = isRecord(value.result) ? value.result : {};
  const output = contentText(result.content);
  const isError = value.isError === true;
  const item: UiToolItem = {
    ...previous,
    status: isError ? 'failed' : 'completed',
    ...(isError ? { error: output ?? 'pi tool failed' } : output !== undefined ? { output } : {}),
  };
  const tools = new Map(state.tools);
  tools.set(id, item);
  return { events: [{ type: 'item.completed', item }], state: { ...state, tools } };
}

function completeTurn(reason: StopReason, state: PiUiMapperState): PiUiMapping {
  if (!state.turnId) return { events: [], state };
  const event: Extract<UiEvent, { type: 'turn.completed' }> = {
    type: 'turn.completed',
    turnId: state.turnId,
    stopReason: reason,
  };
  if (state.turnUsage) event.usage = state.turnUsage;
  if (state.turnCostUsd !== null) event.costUsd = state.turnCostUsd;
  // Cleared with the turn id: the next turn's counts are its own, and a turn pi ends without
  // reporting usage must not inherit the previous turn's numbers.
  return { events: [event], state: { ...state, turnId: null, turnUsage: null, turnCostUsd: null } };
}

function mapMessageEnd(value: Record<string, unknown>, state: PiUiMapperState): PiUiMapping {
  const message = isRecord(value.message) ? value.message : undefined;
  const usage = message && message.role === 'assistant' ? usageEvent(message.usage) : undefined;
  if (!usage) return { events: [], state };
  return {
    events: [usage],
    state: { ...state, turnUsage: usage.usage, turnCostUsd: usage.costUsd ?? null },
  };
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

function toolDiffs(name: string, input: unknown): UiToolItem['diffs'] | undefined {
  if (!isRecord(input) || !['edit', 'write'].includes(name.toLowerCase())) return undefined;
  const path = string(input.path) ?? string(input.file_path) ?? string(input.filePath);
  if (!path) return undefined;
  const oldText = string(input.oldText) ?? string(input.old_string) ?? (name.toLowerCase() === 'write' ? null : undefined);
  const newText = string(input.newText) ?? string(input.new_string) ?? string(input.content);
  if (oldText === undefined && newText === undefined) return undefined;
  return [{ path, oldText: oldText ?? null, ...(newText !== undefined ? { newText } : {}) }];
}

function toolPlan(name: string, input: unknown): PlanEntry[] | undefined {
  if (!['todowrite', 'todo_write'].includes(name.toLowerCase()) || !isRecord(input) || !Array.isArray(input.todos)) {
    return undefined;
  }
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo)) continue;
    const content = string(todo.content);
    const status = string(todo.status);
    if (!content || !['pending', 'in_progress', 'completed', 'cancelled'].includes(status ?? '')) continue;
    entries.push({ content, status: status as PlanEntry['status'] });
  }
  return entries;
}

function rpcError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `pi RPC command ${string(value.command) ?? 'unknown'} failed`;
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

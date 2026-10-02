/**
 * Kilo Code CLI `run --format json` → protocol v2 mapper (+ v1 helpers).
 *
 * Wire shapes (verified against kilo 7.7.9, `kilo run --auto --format json`):
 * one JSON object per line —
 *   `{"type":"step_start", "sessionID", "part":{"type":"step-start", ...}}`
 *   `{"type":"text", "sessionID", "part":{"type":"text", "text", ...}}`
 *   `{"type":"tool_use", "sessionID", "part":{"type":"tool", "callID", "tool",
 *     "state":{"status", "input", "output", "title", ...}}}`
 *   `{"type":"step_finish", "sessionID", "part":{"type":"step-finish",
 *     "reason", "tokens":{"total","input","output",...}, "cost", ...}}`
 *   `{"type":"error", "sessionID", "error":{"name", "data":{"message"}}}}`
 *
 * The `run` process is one-shot: it exits when the turn is over, so (like the
 * cursor print-mode mapper) the session starts turn_1 with the first event and
 * the runner closes the turn when the process ends. `step_finish` frames carry
 * cumulative per-message token counts, which feed `usage.updated` directly.
 *
 * Capability notes (see `ui-parity.test.ts` except lists):
 *  - no thinking channel: `run --format json` emits finished text blocks only;
 *  - no plan channel: checklist state never appears on this wire;
 *  - tool states carry a rendered `output` string, never structured diffs;
 *  - no parent-attribution for nested work: a subtask's parts share the same
 *    session id, so nesting cannot be attributed (same cell as codex/cursor/pi).
 *
 * Never throws on malformed input. State is immutable — callers thread the
 * returned `state` into the next call.
 */

import type { AgentEvent } from './agent-runner.ts';
import type {
  StopReason,
  TokenUsage,
  UiEvent,
  UiMessageItem,
  UiSessionStartedEvent,
  UiToolItem,
  UiTurnCompletedEvent,
  UiUsageUpdatedEvent,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

// ---- v2 state ---------------------------------------------------------------

export interface KiloUiMapperState {
  readonly sessionId: string | null;
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  readonly itemSeq: number;
  readonly openTools: ReadonlyMap<string, UiToolItem>;
  readonly turnErrored: boolean;
  readonly usageInput: number;
  readonly usageOutput: number;
  readonly usageTotal: number;
  readonly costUsd: number | null;
}

export interface KiloUiMapping {
  events: UiEvent[];
  state: KiloUiMapperState;
}

export function createKiloUiState(): KiloUiMapperState {
  return {
    sessionId: null,
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    itemSeq: 0,
    openTools: new Map(),
    turnErrored: false,
    usageInput: 0,
    usageOutput: 0,
    usageTotal: 0,
    costUsd: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Fold one parsed `kilo run --format json` line into v2 events. Never throws. */
export function mapKiloMessage(msg: unknown, state: KiloUiMapperState): KiloUiMapping {
  try {
    if (!isRecord(msg)) return { events: [], state };
    const sessionId = str(msg.sessionID);
    let next = state;
    let events: UiEvent[] = [];
    if (sessionId && !next.sessionStarted) {
      const started = kiloSessionStarted(sessionId, next);
      events = started.events;
      next = started.state;
    } else if (sessionId && next.sessionId === null) {
      next = { ...next, sessionId };
    }
    switch (msg.type) {
      case 'text':
        return mapText(msg, next, events);
      case 'tool_use':
        return mapToolUse(msg, next, events);
      case 'step_finish':
        return mapStepFinish(msg, next, events);
      case 'error':
        return mapError(next, events);
      default:
        return { events, state: next };
    }
  } catch {
    return { events: [], state };
  }
}

/** `session.started` + `turn.started` for a session id. Emitted once. */
export function kiloSessionStarted(sessionId: string, state: KiloUiMapperState): KiloUiMapping {
  if (state.sessionStarted) return { events: [], state };
  const event: UiSessionStartedEvent = {
    type: 'session.started',
    sessionId,
    backend: 'kilo',
  };
  const turnId = `turn_${state.turnSeq + 1}`;
  return {
    events: [event, { type: 'turn.started', turnId }],
    state: {
      ...state,
      sessionId,
      sessionStarted: true,
      turnSeq: state.turnSeq + 1,
      currentTurnId: turnId,
    },
  };
}

function mapText(
  msg: Record<string, unknown>,
  state: KiloUiMapperState,
  prefix: UiEvent[],
): KiloUiMapping {
  const part = isRecord(msg.part) ? msg.part : undefined;
  const text = part ? str(part.text) : undefined;
  if (!text) return { events: prefix, state };
  const item: UiMessageItem = {
    kind: 'message',
    id: `item_${state.itemSeq + 1}`,
    role: 'assistant',
    text,
  };
  return {
    events: [...prefix, { type: 'item.started', item }, { type: 'item.completed', item }],
    state: { ...state, itemSeq: state.itemSeq + 1 },
  };
}

function mapToolUse(
  msg: Record<string, unknown>,
  state: KiloUiMapperState,
  prefix: UiEvent[],
): KiloUiMapping {
  const part = isRecord(msg.part) ? msg.part : undefined;
  if (!part) return { events: prefix, state };
  const callId = str(part.callID) ?? str(part.id) ?? `item_${state.itemSeq + 1}`;
  const name = str(part.tool) ?? 'unknown';
  const toolState = isRecord(part.state) ? part.state : undefined;
  const input = toolState?.input;
  const display = toolDisplay(name, input);
  const status = str(toolState?.status)?.toLowerCase();
  const failed = status !== undefined && status !== 'completed' && status !== 'running' && status !== 'pending';
  const started: UiToolItem = {
    kind: 'tool',
    id: callId,
    name,
    toolKind: display.toolKind,
    title: display.title,
    status: 'running',
  };
  if (input !== undefined) started.input = input;
  const finished: UiToolItem = { ...started, status: failed ? 'failed' : 'completed' };
  const output = toolState !== undefined ? str(toolState.output) : undefined;
  if (output !== undefined && output !== '') finished.output = output;
  if (failed) {
    const err = str(toolState?.error) ?? output;
    if (err) finished.error = err;
  }
  const openTools = new Map(state.openTools);
  openTools.set(callId, started);
  const completedTools = new Map(openTools);
  completedTools.delete(callId);
  return {
    events: [
      ...prefix,
      { type: 'item.started', item: started },
      { type: 'item.completed', item: finished },
    ],
    state: { ...state, itemSeq: state.itemSeq + 1, openTools: completedTools },
  };
}

function kiloTokens(part: Record<string, unknown>): TokenUsage | undefined {
  const tokens = isRecord(part.tokens) ? part.tokens : undefined;
  if (!tokens) return undefined;
  const input = num(tokens.input) ?? 0;
  const output = num(tokens.output) ?? 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const cacheRead = (cache !== undefined ? num(cache.read) : undefined)
    ?? num(tokens.cacheRead) ?? 0;
  const cacheWrite = (cache !== undefined ? num(cache.write) : undefined)
    ?? num(tokens.cacheCreation) ?? 0;
  const total = num(tokens.total) ?? input + output + cacheRead + cacheWrite;
  if (total <= 0) return undefined;
  const usage: TokenUsage = { input, output, total };
  if (cacheRead > 0) usage.cacheRead = cacheRead;
  if (cacheWrite > 0) usage.cacheWrite = cacheWrite;
  return usage;
}

function mapStepFinish(
  msg: Record<string, unknown>,
  state: KiloUiMapperState,
  prefix: UiEvent[],
): KiloUiMapping {
  const part = isRecord(msg.part) ? msg.part : undefined;
  if (!part) return { events: prefix, state };
  const usage = kiloTokens(part);
  const cost = num(part.cost);
  let next = state;
  const events = [...prefix];
  if (usage) {
    // `step_finish` counts are cumulative per message, so the latest snapshot
    // wins rather than sums.
    next = {
      ...next,
      usageInput: Math.max(next.usageInput, usage.input),
      usageOutput: Math.max(next.usageOutput, usage.output),
      usageTotal: Math.max(next.usageTotal, usage.total),
      costUsd: cost ?? next.costUsd,
    };
    const event: UiUsageUpdatedEvent = {
      type: 'usage.updated',
      usage: {
        input: next.usageInput,
        output: next.usageOutput,
        total: next.usageTotal,
      },
    };
    if (next.costUsd !== null) event.costUsd = next.costUsd;
    events.push(event);
  } else if (cost !== undefined) {
    next = { ...next, costUsd: cost };
  }
  return { events, state: next };
}

function mapError(state: KiloUiMapperState, prefix: UiEvent[]): KiloUiMapping {
  const events = [...prefix];
  const openTools = new Map(state.openTools);
  for (const open of openTools.values()) {
    events.push({ type: 'item.completed', item: { ...open, status: 'failed' } });
  }
  return {
    events,
    state: { ...state, openTools: new Map(), turnErrored: true },
  };
}

/**
 * Close the turn when the `kilo run` process ends — the one-shot CLI has no
 * terminal result frame, so the runner calls this once after draining stdout.
 */
export function kiloTurnCompleted(
  state: KiloUiMapperState,
  stopReason?: StopReason,
): KiloUiMapping {
  const events: UiEvent[] = [];
  for (const open of state.openTools.values()) {
    events.push({ type: 'item.completed', item: { ...open, status: 'failed' } });
  }
  const turnId = state.currentTurnId ?? `turn_${Math.max(1, state.turnSeq)}`;
  const turnEvent: UiTurnCompletedEvent = {
    type: 'turn.completed',
    turnId,
    stopReason: stopReason ?? (state.turnErrored ? 'error' : 'end_turn'),
  };
  if (state.usageTotal > 0) {
    turnEvent.usage = {
      input: state.usageInput,
      output: state.usageOutput,
      total: state.usageTotal,
    };
  }
  if (state.costUsd !== null) turnEvent.costUsd = state.costUsd;
  events.push(turnEvent);
  return {
    events,
    state: { ...state, currentTurnId: null, openTools: new Map() },
  };
}

// ---- v1 helpers -------------------------------------------------------------

/** Extract the kilo session id from a parsed line, when it carries one. */
export function kiloSessionId(msg: unknown): string | undefined {
  if (!isRecord(msg)) return undefined;
  return str(msg.sessionID);
}

/**
 * Map one parsed line to v1 `AgentEvent`s (text / tool-call / tool-result /
 * token-usage / error). `turnErrored` lines map to zero events here — the
 * runner reports the process outcome itself.
 */
export function mapKiloStreamEvent(msg: unknown): AgentEvent[] {
  if (!isRecord(msg)) return [];
  const part = isRecord(msg.part) ? msg.part : undefined;
  switch (msg.type) {
    case 'text': {
      const text = part ? str(part.text) : undefined;
      return text ? [{ type: 'text', text }] : [];
    }
    case 'tool_use': {
      if (!part) return [];
      const callId = str(part.callID) ?? str(part.id) ?? '';
      if (!callId) return [];
      const name = str(part.tool) ?? 'unknown';
      const toolState = isRecord(part.state) ? part.state : undefined;
      const input = toolState?.input;
      const status = str(toolState?.status)?.toLowerCase();
      const failed = status !== undefined && status !== 'completed' && status !== 'running' && status !== 'pending';
      const output = toolState !== undefined ? str(toolState.output) ?? '' : '';
      return [
        { type: 'tool-call', id: callId, tool: name, input },
        { type: 'tool-result', toolCallId: callId, result: output, isError: failed },
      ];
    }
    case 'step_finish': {
      if (!part) return [];
      const usage = kiloTokens(part);
      if (!usage || usage.total <= 0) return [];
      return [{ type: 'token-usage', tokensUsed: usage.total }];
    }
    case 'error': {
      const err = isRecord(msg.error) ? msg.error : undefined;
      const data = err !== undefined && isRecord(err.data) ? err.data : undefined;
      const message = (data !== undefined ? str(data.message) : undefined)
        ?? (err !== undefined ? str(err.message) : undefined)
        ?? 'kilo run failed';
      return [{ type: 'error', message: `kilo: ${message}` }];
    }
    default:
      return [];
  }
}

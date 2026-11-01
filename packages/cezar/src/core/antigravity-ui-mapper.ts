/**
 * Pure Antigravity CLI (`agy`) stream-json → normalized protocol mapper (v2 `UiEvent` + v1 `AgentEvent`).
 *
 * Wire contract: `agy --output-format stream-json` prints one `init` frame per process, then per
 * turn a run of `step_update` frames and one `result` frame. Every shape handled here was read off
 * live agy 1.4.0 captures (`__fixtures__/antigravity/README.md`):
 *
 *  - each turn opens with a `user_input` step and closes with `result` — the process stays up
 *    between turns when it reads `--input-format stream-json`, so a session carries many turns;
 *  - `agent_response` steps stream `text_delta`s and report that step's own `usage` when DONE;
 *    `result.usage` is cumulative for the whole CONVERSATION (a `--conversation` resume included),
 *    so turn usage is the sum of the step usages, never the result's;
 *  - `tool` steps go ACTIVE → DONE | ERROR with `tool_info.{parameters, output, error.message}`;
 *  - `subagent` steps (`invoke_subagent`) carry `subagent_info.subagents[]`.
 *
 * Unknown or malformed frames produce no events; the mapper never throws and never mutates the
 * state it is given.
 */
import type { AgentEvent } from './agent-runner.ts';
import type { StopReason, TokenUsage, UiEvent, UiItem, UiMessageItem, UiToolItem } from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

export interface AntigravityUiState {
  readonly sessionId?: string;
  /** Built for a `--conversation` resume, where `result.usage` already counts earlier processes. */
  readonly resumed: boolean;
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  /** The open turn, or null between a `result` and the next turn's first step. */
  readonly turnId: string | null;
  readonly turnHasText: boolean;
  /** Sum of this turn's per-step usage. */
  readonly turnUsage: TokenUsage | null;
  /** Sum of every turn this process has completed — `usage.updated` is cumulative for the session. */
  readonly sessionUsage: TokenUsage | null;
  /** The v1 `token-usage` running total (cost-weighted the way pi weights cache reads). */
  readonly tokensUsed: number;
  readonly stopReason: StopReason;
  /** In-flight items, keyed by agy's step index (unique across a conversation, resumes included). */
  readonly items: ReadonlyMap<number, UiItem>;
}

export interface AntigravityMapping {
  state: AntigravityUiState;
  events: UiEvent[];
  agentEvents: AgentEvent[];
}

export function createAntigravityUiState(sessionId?: string): AntigravityUiState {
  return {
    ...(sessionId ? { sessionId } : {}),
    resumed: sessionId !== undefined,
    sessionStarted: false,
    turnSeq: 0,
    turnId: null,
    turnHasText: false,
    turnUsage: null,
    sessionUsage: null,
    tokensUsed: 0,
    stopReason: 'end_turn',
    items: new Map(),
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** agy's tool names → the cross-backend names `toolDisplay` already knows. */
const ALIASES: Readonly<Record<string, string>> = {
  run_command: 'Bash',
  view_file: 'Read',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
  invoke_subagent: 'Task',
};

function toolName(raw: string): string {
  const key = raw.toLowerCase();
  return Object.hasOwn(ALIASES, key) ? ALIASES[key]! : raw;
}

function stepUsage(value: unknown): TokenUsage | null {
  const raw = record(value);
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const reasoning = count(raw.thinking_tokens);
  const cacheRead = count(raw.cache_read_tokens);
  const total = count(raw.total_tokens) || input + output;
  if (!input && !output && !total) return null;
  return { input, output, total, ...(reasoning ? { reasoning } : {}), ...(cacheRead ? { cacheRead } : {}) };
}

function addUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  const cacheRead = (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    ...(reasoning ? { reasoning } : {}),
    ...(cacheRead ? { cacheRead } : {}),
  };
}

const weighted = (usage: TokenUsage): number => Math.round(usage.input + usage.output + (usage.cacheRead ?? 0) * 0.1);

function stopReasonOf(status: string): StopReason {
  if (status === 'SUCCESS' || status === 'WAITING') return 'end_turn';
  if (status === 'CANCELED' || status === 'CANCELLED' || status === 'INTERRUPTED') return 'cancelled';
  return 'error';
}

/** Tool input with the cross-backend `path` / `command` keys `toolDisplay` reads. */
function toolInput(params: Record<string, unknown>): Record<string, unknown> {
  const path = string(params.TargetFile) || string(params.AbsolutePath) || string(params.Path) || string(params.SearchPath);
  return {
    ...params,
    ...(path ? { path } : {}),
    ...(typeof params.CommandLine === 'string' ? { command: params.CommandLine } : {}),
    ...(typeof params.Query === 'string' ? { pattern: params.Query, query: params.Query } : {}),
    ...(typeof params.Url === 'string' ? { url: params.Url } : {}),
  };
}

/** `invoke_subagent` input in the `Task` shape: who was spawned, and with what brief. */
function subagentInput(info: Record<string, unknown>): Record<string, unknown> {
  const agents = Array.isArray(info.subagents) ? info.subagents.map(record) : [];
  const roles = agents.map((agent) => string(agent.role)).filter(Boolean);
  const types = agents.map((agent) => string(agent.type_name)).filter(Boolean);
  const prompt = agents.map((agent) => string(agent.initial_prompt)).filter(Boolean).join('\n\n');
  return {
    ...(roles.length ? { description: roles.join(', ') } : {}),
    ...(types.length ? { subagent_type: [...new Set(types)].join(', ') } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function subagentOutput(info: Record<string, unknown>): string {
  const agents = Array.isArray(info.subagents) ? info.subagents.map(record) : [];
  return agents
    .map((agent) => {
      const who = string(agent.role) || string(agent.type_name) || 'subagent';
      const id = string(agent.conversation_id);
      return id ? `${who}: conversation ${id}` : who;
    })
    .join('\n');
}

export function mapAntigravityMessage(raw: unknown, previous: AntigravityUiState): AntigravityMapping {
  const events: UiEvent[] = [];
  const agentEvents: AgentEvent[] = [];
  const frame = record(raw);
  const kind = string(frame.event);
  if (kind !== 'init' && kind !== 'step_update' && kind !== 'result') return { state: previous, events, agentEvents };

  const payload = record(frame[kind]);
  let state: AntigravityUiState = previous;
  const items = new Map(previous.items);
  const update = (patch: Partial<AntigravityUiState>): void => {
    state = { ...state, ...patch };
  };

  const sessionId = string(frame.conversation_id) || string(payload.conversation_id);
  if (sessionId && sessionId !== state.sessionId) {
    update({ sessionId });
    agentEvents.push({ type: 'session', sessionId });
  }
  if (!state.sessionStarted) {
    events.push({
      type: 'session.started',
      backend: 'antigravity',
      sessionId: state.sessionId ?? '',
      ...(string(payload.model) ? { model: string(payload.model) } : {}),
      ...(string(payload.cwd) ? { cwd: string(payload.cwd) } : {}),
      ...(Array.isArray(payload.tools) ? { tools: payload.tools.filter((v): v is string => typeof v === 'string') } : {}),
    });
    update({ sessionStarted: true });
  }
  if (kind === 'init') return { state: { ...state, items }, events, agentEvents };

  // A turn opens with its first frame — agy echoes each stdin message back as a `user_input` step.
  if (state.turnId === null) {
    const turnSeq = state.turnSeq + 1;
    const turnId = `turn_${turnSeq}`;
    events.push({ type: 'turn.started', turnId });
    update({ turnSeq, turnId, turnHasText: false, turnUsage: null, stopReason: 'end_turn' });
  }

  if (kind === 'step_update' && Number.isInteger(payload.step_index)) {
    const index = payload.step_index as number;
    const existing = items.get(index);
    const terminal = payload.state === 'DONE' || payload.state === 'ERROR';
    const stepType = string(payload.step_type);
    const usage = stepUsage(payload.usage);
    if (usage && terminal) update({ turnUsage: addUsage(state.turnUsage, usage) });

    if (stepType === 'agent_response') {
      const delta = string(payload.text_delta);
      const text = (existing?.kind === 'message' ? existing.text : '') + delta;
      if (delta || existing) {
        const item: UiMessageItem = { kind: 'message', id: `msg_${index}`, role: 'assistant', text };
        if (!existing) events.push({ type: 'item.started', item });
        else if (delta) events.push({ type: 'item.delta', itemId: item.id, field: 'text', delta });
        if (terminal) {
          events.push({ type: 'item.completed', item });
          items.delete(index);
          // v1 `text` is whole-message (`v1-text-coalescer.ts`): a turn-end marker split across
          // deltas must reach the run manager in one piece.
          if (text) agentEvents.push({ type: 'text', text });
        } else items.set(index, item);
        if (text) update({ turnHasText: true });
      }
    } else if (stepType === 'tool' || stepType === 'subagent') {
      const info = record(payload.tool_info);
      const subagent = stepType === 'subagent' || payload.subagent_info != null;
      const subInfo = record(payload.subagent_info);
      const name = toolName(string(payload.tool_name) || string(info.name) || (subagent ? 'invoke_subagent' : 'tool'));
      let item: UiToolItem;
      if (existing?.kind === 'tool') item = existing;
      else {
        const input = subagent ? subagentInput(subInfo) : toolInput(record(info.parameters));
        const display = toolDisplay(subagent ? 'Task' : name, input);
        const path = string(input.path);
        item = {
          kind: 'tool',
          id: `step_${index}`,
          name,
          title: display.title,
          toolKind: subagent ? 'task' : display.toolKind,
          status: 'running',
          input,
          ...(path ? { locations: [{ path }] } : {}),
        };
        events.push({ type: 'item.started', item });
        agentEvents.push({ type: 'tool-call', id: item.id, tool: name, input });
      }
      if (terminal) {
        const errorInfo = info.error;
        const failed = payload.state === 'ERROR' || errorInfo != null;
        const error = string(record(errorInfo).message) || string(errorInfo) || 'tool failed';
        const output = subagent ? subagentOutput(subInfo) : string(info.output);
        item = {
          ...item,
          status: failed ? 'failed' : 'completed',
          ...(failed ? { error } : {}),
          ...(!failed && output ? { output } : {}),
        };
        events.push({ type: 'item.completed', item });
        agentEvents.push({ type: 'tool-result', toolCallId: item.id, result: failed ? error : output, isError: failed });
        items.delete(index);
      } else items.set(index, item);
    }
  }

  if (kind === 'result') {
    const status = string(payload.status);
    const stopReason = stopReasonOf(status);
    for (const item of items.values()) {
      if (item.kind === 'tool') {
        events.push({ type: 'item.completed', item: { ...item, status: 'failed', error: 'Turn ended before the tool completed' } });
        agentEvents.push({ type: 'tool-result', toolCallId: item.id, result: 'Turn ended before the tool completed', isError: true });
      } else {
        events.push({ type: 'item.completed', item });
        if (item.kind === 'message' && item.text) agentEvents.push({ type: 'text', text: item.text });
      }
    }
    items.clear();
    // A turn whose text never streamed still has its final answer in `response`.
    const response = string(payload.response);
    if (!state.turnHasText && response && stopReason !== 'error') {
      const item: UiMessageItem = { kind: 'message', id: `msg_result_${state.turnSeq}`, role: 'assistant', text: response };
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
      agentEvents.push({ type: 'text', text: response });
    }
    // No per-step usage at all (an older CLI, a turn that failed before a step): fall back to the
    // result's figure, which is only exact for the first turn of a fresh conversation.
    const turnUsage = state.turnUsage ?? (state.sessionUsage === null && !state.resumed ? stepUsage(payload.usage) : null);
    events.push({ type: 'turn.completed', turnId: state.turnId!, stopReason, ...(turnUsage ? { usage: turnUsage } : {}) });
    if (turnUsage) {
      const sessionUsage = addUsage(state.sessionUsage, turnUsage);
      const tokensUsed = state.tokensUsed + weighted(turnUsage);
      events.push({ type: 'usage.updated', usage: sessionUsage });
      agentEvents.push({ type: 'token-usage', tokensUsed });
      update({ sessionUsage, tokensUsed });
    }
    if (stopReason === 'error') {
      const message = string(payload.error).trim() || `Antigravity turn failed (status: ${status || 'unknown'})`;
      agentEvents.push({ type: 'error', message });
      events.push({ type: 'session.error', message, fatal: false });
    }
    update({ turnId: null, turnHasText: false, turnUsage: null, stopReason });
  }

  return { state: { ...state, items }, events, agentEvents };
}

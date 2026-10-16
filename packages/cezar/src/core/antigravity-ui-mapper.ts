import type { AgentEvent } from './agent-runner.ts';
import type { StopReason, TokenUsage, UiEvent, UiItem, UiToolItem } from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

// Wire contract: https://antigravity.google/docs/cli/headless/ (init, step_update, result).
export interface AntigravityUiState {
  sessionId?: string;
  started: boolean;
  finished: boolean;
  hasText: boolean;
  items: ReadonlyMap<number, UiItem>;
}
export function createAntigravityUiState(sessionId?: string): AntigravityUiState {
  return { sessionId, started: false, finished: false, hasText: false, items: new Map() };
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const aliases: Record<string, string> = {
  run_command: 'Bash', view_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit', sed_file: 'Edit', grep_search: 'Grep', find_by_name: 'Glob',
  read_url_content: 'WebFetch', search_web: 'WebSearch',
};

export function mapAntigravityMessage(raw: unknown, previous: AntigravityUiState): {
  state: AntigravityUiState; events: UiEvent[]; agentEvents: AgentEvent[];
} {
  const events: UiEvent[] = [];
  const agentEvents: AgentEvent[] = [];
  const frame = record(raw);
  const event = string(frame.event);
  if (!['init', 'step_update', 'result'].includes(event) || previous.finished) {
    return { state: previous, events, agentEvents };
  }
  const payload = record(frame[event]);
  const state = { ...previous, items: new Map(previous.items) };
  const sessionId = string(frame.conversation_id) || string(payload.conversation_id);
  if (sessionId && state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    agentEvents.push({ type: 'session', sessionId });
  }
  if (!state.started) {
    events.push({ type: 'session.started', backend: 'antigravity', sessionId: state.sessionId ?? '',
      ...(string(payload.cwd) ? { cwd: string(payload.cwd) } : {}),
      ...(string(payload.model) ? { model: string(payload.model) } : {}),
      ...(Array.isArray(payload.tools) ? { tools: payload.tools.filter((v): v is string => typeof v === 'string') } : {}),
    }, { type: 'turn.started', turnId: 'turn_1' });
    state.started = true;
  }
  if (frame.event === 'step_update' && Number.isInteger(payload.step_index)) {
    const index = payload.step_index as number;
    const existing = state.items.get(index);
    const terminal = payload.state === 'DONE' || payload.state === 'ERROR';
    if (payload.step_type === 'agent_response') {
      const delta = string(payload.text_delta);
      const text = (existing?.kind === 'message' ? existing.text : '') + delta;
      if (delta || existing) {
        const item: UiItem = { kind: 'message', id: `msg_${index}`, role: 'assistant', text };
        if (!existing) events.push({ type: 'item.started', item });
        else if (delta) events.push({ type: 'item.delta', itemId: item.id, field: 'text', delta });
        if (delta) { agentEvents.push({ type: 'text', text: delta }); state.hasText = true; }
        if (terminal) { events.push({ type: 'item.completed', item }); state.items.delete(index); }
        else state.items.set(index, item);
      }
    } else if (payload.step_type === 'tool') {
      const info = record(payload.tool_info);
      const rawName = string(payload.tool_name) || string(info.name) || 'tool';
      const key = rawName.toLowerCase();
      const name = Object.hasOwn(aliases, key) ? aliases[key]! : rawName;
      const params = record(info.parameters);
      const path = string(params.TargetFile) || string(params.AbsolutePath) || string(params.Path);
      const input = { ...params, ...(path ? { path } : {}),
        ...(typeof params.CommandLine === 'string' ? { command: params.CommandLine } : {}) };
      let item: UiToolItem;
      if (existing?.kind === 'tool') item = existing;
      else {
        const display = toolDisplay(name, input);
        item = { kind: 'tool', id: `step_${index}`, name, title: display.title,
          toolKind: payload.subagent_info && typeof payload.subagent_info === 'object' ? 'task' : display.toolKind,
          status: 'running', input, ...(path ? { locations: [{ path }] } : {}) };
        events.push({ type: 'item.started', item });
        agentEvents.push({ type: 'tool-call', id: item.id, tool: name, input });
      }
      if (terminal) {
        const failed = payload.state === 'ERROR' || info.error != null;
        const error = string(record(info.error).message) || string(info.error) || 'tool failed';
        const output = string(info.output);
        item = { ...item, status: failed ? 'failed' : 'completed',
          ...(failed ? { error } : {}), ...(typeof info.output === 'string' ? { output } : {}) };
        events.push({ type: 'item.completed', item });
        agentEvents.push({ type: 'tool-result', toolCallId: item.id, result: failed ? error : output, isError: failed });
        state.items.delete(index);
      } else state.items.set(index, item);
    }
  }
  if (frame.event === 'result') {
    const status = string(payload.status);
    const stopReason: StopReason = ['SUCCESS', 'WAITING'].includes(status) ? 'end_turn'
      : ['CANCELED', 'INTERRUPTED'].includes(status) ? 'cancelled' : 'error';
    for (const item of state.items.values()) {
      events.push({ type: 'item.completed', item: item.kind === 'tool' ? { ...item, status: 'failed' } : item });
      if (item.kind === 'tool') agentEvents.push({ type: 'tool-result', toolCallId: item.id, result: 'Turn ended before tool completion', isError: true });
    }
    state.items.clear();
    const response = string(payload.response);
    if (!state.hasText && response && stopReason !== 'error') {
      const item: UiItem = { kind: 'message', id: 'msg_result', role: 'assistant', text: response };
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
      agentEvents.push({ type: 'text', text: response });
      state.hasText = true;
    }
    const rawUsage = record(payload.usage);
    const usage: TokenUsage = { input: count(rawUsage.input_tokens), output: count(rawUsage.output_tokens),
      total: count(rawUsage.total_tokens) || count(rawUsage.input_tokens) + count(rawUsage.output_tokens),
      ...(count(rawUsage.thinking_tokens) ? { reasoning: count(rawUsage.thinking_tokens) } : {}),
      ...(count(rawUsage.cache_read_tokens) ? { cacheRead: count(rawUsage.cache_read_tokens) } : {}) };
    events.push({ type: 'turn.completed', turnId: 'turn_1', stopReason, ...(usage.total ? { usage } : {}) });
    if (usage.total) {
      events.push({ type: 'usage.updated', usage });
      agentEvents.push({ type: 'token-usage', tokensUsed: usage.total });
    }
    if (stopReason === 'error') {
      const message = string(payload.error) || `Antigravity status: ${status || 'unknown'}`;
      agentEvents.push({ type: 'error', message });
      events.push({ type: 'session.error', message, fatal: true });
    }
    state.finished = true;
  }
  return { state, events, agentEvents };
}

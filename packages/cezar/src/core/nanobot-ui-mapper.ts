/** Native bridge wire: packages/cezar/scripts/nanobot-cezar.py. No inferred tool/usage events. */
import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent, UiToolItem, StopReason } from './ui-events.ts';

export class NanobotEventMapper {
  private sequence = 0;
  private turn = 0;
  private sessionId?: string;
  private cwd?: string;
  private tools = new Map<string, UiToolItem>();
  stopReason: StopReason = 'end_turn';

  map(value: unknown): { agent: AgentEvent[]; ui: UiEvent[] } {
    const agent: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { agent, ui };
    const v = value as Record<string, unknown>;
    if (v.type === 'ready' && typeof v.sessionId === 'string') {
      this.sessionId = v.sessionId;
      this.cwd = typeof v.cwd === 'string' ? v.cwd : undefined;
      agent.push({ type: 'session', sessionId: v.sessionId });
      if (typeof v.model === 'string') ui.push({ type: 'session.started', backend: 'nanobot', sessionId: v.sessionId,
        ...(typeof v.model === 'string' ? { model: v.model } : {}),
        ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}) });
    } else if (v.type === 'model' && typeof v.model === 'string' && this.sessionId) {
      // Runtime selection is configuration evidence, not a provider-response model assertion.
      ui.push({ type: 'session.started', backend: 'nanobot', sessionId: this.sessionId,
        model: v.model, modelSource: 'runtime-selection', ...(this.cwd ? { cwd: this.cwd } : {}) });
    } else if (v.type === 'turn-start') {
      this.turn++;
      this.stopReason = 'end_turn';
      ui.push({ type: 'turn.started', turnId: `nanobot-turn-${this.turn}` });
    } else if ((v.type === 'text' || v.type === 'reasoning') && typeof v.text === 'string') {
      const id = `nanobot-message-${++this.sequence}`;
      if (v.type === 'text') {
        agent.push({ type: 'text', text: v.text });
        ui.push({ type: 'item.completed', item: { kind: 'message', role: 'assistant', id, text: v.text } });
      } else ui.push({ type: 'item.completed', item: { kind: 'reasoning', id, text: v.text } });
    } else if (v.type === 'tool-call' && typeof v.id === 'string' && typeof v.tool === 'string') {
      const input = v.input && typeof v.input === 'object' ? v.input as Record<string, unknown> : {};
      const item: UiToolItem = { kind: 'tool', id: v.id, name: v.tool, title: v.tool,
        toolKind: v.tool === 'subagent' && input.action === 'create' ? 'task' :
          v.tool === 'edit_file' || v.tool === 'write_file' ? 'edit' :
          v.tool === 'read_file' ? 'read' : v.tool === 'exec' ? 'execute' : 'other',
        status: 'running', input: v.input };
      this.tools.set(v.id, item);
      agent.push({ type: 'tool-call', id: v.id, tool: v.tool, input: v.input });
      ui.push({ type: 'item.started', item });
    } else if (v.type === 'tool-result' && typeof v.id === 'string' && typeof v.result === 'string') {
      agent.push({ type: 'tool-result', toolCallId: v.id, result: v.result, isError: v.isError === true });
      const previous = this.tools.get(v.id);
      if (previous) {
        ui.push({ type: 'item.completed', item: { ...previous, output: v.result,
          status: v.isError === true ? 'failed' : 'completed' } });
        this.tools.set(v.id, { ...previous, output: v.result, status: v.isError === true ? 'failed' : 'completed' });
      }
    } else if (v.type === 'file-edit' && v.event && typeof v.event === 'object') {
      const edit = v.event as Record<string, unknown>;
      const diff = edit.diff && typeof edit.diff === 'object' ? edit.diff as Record<string, unknown> : {};
      const previous = typeof edit.call_id === 'string' ? this.tools.get(edit.call_id) : undefined;
      if (previous && edit.phase === 'end' && typeof edit.path === 'string' &&
          diff.format === 'unified' && typeof diff.text === 'string') {
        const item: UiToolItem = { ...previous, toolKind: 'edit', diffs: [
          ...(previous.diffs ?? []).filter((d) => d.path !== edit.path),
          { path: edit.path, oldText: edit.operation === 'create' ? null : '', unified: diff.text },
        ] };
        this.tools.set(item.id, item);
        ui.push({ type: 'item.updated', item });
      }
    } else if (v.type === 'usage' && typeof v.tokens === 'number' && Number.isFinite(v.tokens) && v.tokens >= 0) {
      agent.push({ type: 'token-usage', tokensUsed: v.tokens });
      if (typeof v.input === 'number' && typeof v.output === 'number') {
        ui.push({ type: 'usage.updated', usage: { input: v.input, output: v.output, total: v.tokens } });
      }
    } else if (v.type === 'turn-end') {
      this.tools.clear();
      agent.push({ type: 'turn-end' });
      ui.push({ type: 'turn.completed', turnId: `nanobot-turn-${this.turn}`, stopReason: this.stopReason,
        ...(typeof v.input === 'number' && typeof v.output === 'number' && typeof v.tokens === 'number'
          ? { usage: { input: v.input, output: v.output, total: v.tokens } } : {}) });
    } else if (v.type === 'error' && typeof v.message === 'string') {
      this.stopReason = 'error';
      agent.push({ type: 'error', message: v.message });
      ui.push({ type: 'session.error', message: v.message, fatal: true });
    } else if (v.type === 'note' && typeof v.message === 'string') {
      agent.push({ type: 'note', message: v.message });
      ui.push({ type: 'session.error', message: v.message, fatal: false });
    }
    return { agent, ui };
  }
}

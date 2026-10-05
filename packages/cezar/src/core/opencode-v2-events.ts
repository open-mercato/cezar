/** Native OpenCode 2.0 events → the existing OpenCode message/part mapper input.
 * Contract: @opencode/client@2.0.19 generated V2Event types; spec 2026-10-05.
 * State belongs to one private server session, never the shared host service.
 */
import { toolDisplay } from './tool-display.ts';

export interface OpencodeMappedEvent {
  type: string;
  properties: Record<string, unknown>;
}

export class OpencodeV2Events {
  private readonly text = new Map<string, string>();
  private readonly tools = new Map<string, { name: string; state: Record<string, unknown> }>();

  constructor(private readonly sessionId: string) {}

  normalize(value: unknown): OpencodeMappedEvent[] {
    if (!record(value) || typeof value.type !== 'string' || !record(value.data)) return [];
    const data = value.data;
    if (data.sessionID !== this.sessionId) return [];
    const type = value.type;
    const event = (type: string, properties: Record<string, unknown>): OpencodeMappedEvent => ({ type, properties });
    if (type === 'session.idle') return [event('session.idle', { sessionID: this.sessionId })];
    if (type === 'session.execution.failed') {
      return [event('session.error', { sessionID: this.sessionId, error: data.error })];
    }
    const mid = data.assistantMessageID;
    if (typeof mid !== 'string') return [];
    const info = event('message.updated', { info: { id: mid, sessionID: this.sessionId, role: 'assistant' } });
    if (type === 'session.step.started') return [info];
    if (type === 'session.step.ended' || type === 'session.step.failed') {
      const events = [event('message.updated', {
        info: { id: mid, sessionID: this.sessionId, role: 'assistant', tokens: data.tokens, cost: data.cost },
      })];
      if (type === 'session.step.failed') events.push(event('session.error', { sessionID: this.sessionId, error: data.error }));
      return events;
    }

    const textEvent = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(type);
    if (textEvent) {
      if (typeof data.ordinal !== 'number' || !Number.isSafeInteger(data.ordinal) || data.ordinal < 0) return [];
      const kind = textEvent[1]!;
      const phase = textEvent[2];
      if (phase === 'delta' && typeof data.delta !== 'string') return [];
      if (phase === 'ended' && typeof data.text !== 'string') return [];
      const id = `${mid}:${kind}:${data.ordinal}`;
      const text = phase === 'ended' ? data.text as string
        : (this.text.get(id) ?? '') + (phase === 'delta' ? data.delta as string : '');
      this.text.set(id, text);
      return [info, event('message.part.updated', {
        part: { id, messageID: mid, sessionID: this.sessionId, type: kind, text,
          ...(phase === 'ended' ? { time: { end: typeof value.created === 'number' ? value.created : 0 } } : {}) },
      })];
    }

    if (!type.startsWith('session.tool.') || typeof data.id !== 'string') return [];
    const id = data.id;
    const previous = this.tools.get(id);
    let name = previous?.name;
    let state: Record<string, unknown> = { ...previous?.state };
    switch (type) {
      case 'session.tool.input.started':
        if (typeof data.name !== 'string') return [];
        name = data.name;
        state = { status: 'pending', input: {} };
        break;
      case 'session.tool.called':
        state = { ...state, status: 'running', input: data.input,
          ...(name ? { title: toolDisplay(name, data.input).title } : {}) };
        break;
      case 'session.tool.progress':
        state = { ...state, metadata: data.metadata };
        break;
      case 'session.tool.success':
        state = { ...state, status: 'completed', output: contentText(data.content), metadata: data.metadata };
        break;
      case 'session.tool.failed':
        state = { ...state, status: 'error', error: data.error, output: contentText(data.content) };
        break;
      default:
        return [];
    }
    // A call without its name-bearing start cannot be safely attributed.
    if (!name) return [];
    this.tools.set(id, { name, state });
    return [info, event('message.part.updated', {
      part: { id, messageID: mid, sessionID: this.sessionId, type: 'tool', tool: name, state },
    })];
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap((item: unknown) => record(item) && item.type === 'text' && typeof item.text === 'string'
    ? [item.text] : []).join('\n');
}

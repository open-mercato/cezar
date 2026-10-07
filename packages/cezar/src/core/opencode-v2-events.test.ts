import { describe, expect, it } from 'vitest';
import { OpencodeV2Events } from './opencode-v2-events.ts';
import { createOpencodeUiState, mapOpencodeEvent, opencodeSessionStarted, opencodeTurnStarted } from './opencode-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';

const native = (type: string, data: Record<string, unknown>) => ({
  id: 'evt_1', created: 1760000000000, type, data: { sessionID: 'ses_1', ...data },
});

describe('OpenCode V2 native events', () => {
  function record() {
    const adapter = new OpencodeV2Events('ses_1');
    let state = opencodeTurnStarted(opencodeSessionStarted('ses_1', createOpencodeUiState()).state).state;
    const events: UiEvent[] = [];
    const send = (type: string, data: Record<string, unknown>) => {
      for (const event of adapter.normalize(native(type, data))) {
        const mapped = mapOpencodeEvent(event, state);
        state = mapped.state;
        events.push(...mapped.events);
      }
    };
    return { adapter, events, send };
  }

  it('streams text and reasoning with stable ids and completes each final snapshot once', () => {
    const { send, events } = record();
    const text = { assistantMessageID: 'msg_1', ordinal: 0 };
    send('session.step.started', { assistantMessageID: 'msg_1' });
    send('session.text.started', text);
    send('session.text.delta', { ...text, delta: 'Hello' });
    send('session.text.delta', { ...text, delta: ' world' });
    send('session.text.ended', { ...text, text: 'Hello world' });
    send('session.text.ended', { ...text, text: 'Hello world' });
    send('session.reasoning.started', { ...text, ordinal: 1 });
    send('session.reasoning.delta', { ...text, ordinal: 1, delta: 'Thinking' });
    send('session.reasoning.ended', { ...text, ordinal: 1, text: 'Thinking' });
    expect(events.filter((e) => e.type === 'item.delta')).toEqual([
      { type: 'item.delta', itemId: 'msg_1:text:0', field: 'text', delta: 'Hello' },
      { type: 'item.delta', itemId: 'msg_1:text:0', field: 'text', delta: ' world' },
      { type: 'item.delta', itemId: 'msg_1:reasoning:1', field: 'reasoning', delta: 'Thinking' },
    ]);
    expect(events.filter((e) => e.type === 'item.completed').map((e) => e.item)).toEqual([
      { kind: 'message', id: 'msg_1:text:0', role: 'assistant', text: 'Hello world' },
      { kind: 'reasoning', id: 'msg_1:reasoning:1', text: 'Thinking' },
    ]);
  });

  it('retains tool name and input through success and failure events', () => {
    const { send, events } = record();
    const tool = { assistantMessageID: 'msg_1', id: 'call_1' };
    send('session.tool.input.started', { ...tool, name: 'shell' });
    send('session.tool.called', { ...tool, input: { command: 'git status' }, executed: true });
    send('session.tool.success', { ...tool, content: [{ type: 'text', text: 'clean' }], metadata: { exit: 0 }, executed: true });
    send('session.tool.input.started', { ...tool, id: 'call_2', name: 'read' });
    send('session.tool.called', { ...tool, id: 'call_2', input: { path: 'missing' }, executed: true });
    send('session.tool.failed', { ...tool, id: 'call_2', error: { type: 'ToolError', message: 'not found' }, executed: true });
    const completed = events.filter((e) => e.type === 'item.completed');
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ item: { id: 'call_1', name: 'shell', toolKind: 'execute', status: 'completed', input: { command: 'git status' }, output: 'clean' } });
    expect(completed[1]).toMatchObject({ item: { id: 'call_2', name: 'read', status: 'failed' } });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'item.updated', item: expect.objectContaining({ id: 'call_1', title: 'Ran git status' }),
    }));
  });

  it('classifies the V2 subagent tool as a task, not an unknown tool', () => {
    const { send, events } = record();
    send('session.tool.input.started', { assistantMessageID: 'msg_1', id: 'call_sub', name: 'subagent' });
    send('session.tool.called', { assistantMessageID: 'msg_1', id: 'call_sub', input: { description: 'Review' }, executed: true });
    expect(events).toContainEqual(expect.objectContaining({ type: 'item.updated', item: expect.objectContaining({ toolKind: 'task' }) }));
  });

  it('maps step usage, errors and native idle into normalized turn completion', () => {
    const { send, events } = record();
    send('session.step.ended', {
      assistantMessageID: 'msg_1', cost: 0.01,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
    });
    send('session.execution.failed', { error: { type: 'ProviderError', message: 'invalid API key', status: 401 } });
    send('session.idle', {});
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage.updated', costUsd: 0.01 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'session.error', message: 'invalid API key' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it('ignores malformed, unknown and foreign-session events', () => {
    const { adapter } = record();
    for (const value of [null, {}, { type: 'session.text.delta', data: null },
      native('session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'msg_1', ordinal: 0, delta: 'secret' }),
      native('future.event', {}), native('session.text.delta', { ordinal: 0, delta: 'invalid' })]) {
      expect(adapter.normalize(value)).toEqual([]);
    }
  });
});

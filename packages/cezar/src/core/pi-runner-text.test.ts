import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { AgentEvent, AgentSession } from './agent-runner.js';
import { PiRunner } from './pi-runner.js';

// Synthetic RPC peer: exercise the actual subprocess, mapper, runner and persistence
// boundaries without needing a provider account. Shapes match mock-pi-rpc.mjs.
const delta = (text: string) => ({
  type: 'message_update',
  message: {},
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text, partial: {} },
});
const endMessage = (text: string) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('PiRunner whole-block v1 text', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cez-pi-text-'));
    vi.stubEnv('CEZ_REDACT_SECRETS', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  function peer(frames: unknown[], hold = false): PiRunner {
    const bin = join(cwd, 'pi-peer.mjs');
    writeFileSync(bin, `#!${process.execPath}
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (JSON.parse(line).type !== 'prompt') continue;
  for (const frame of ${JSON.stringify(frames)}) process.stdout.write(JSON.stringify(frame) + '\\n');
  ${hold ? '' : 'process.stdin.destroy(); break;'}
}
`, { mode: 0o755 });
    return new PiRunner({ bin });
  }

  it('persists a split known token as one masked block while v2 deltas remain live', async () => {
    const token = 'pi-private-credential-abcdefgh';
    const store = RunStore.open(join(cwd, 'data'));
    const run = store.createRun({ title: 'test', task: 'test', workflow: 'quick-task', steps: [] });
    store.registerRunSecrets(run.id, [token]);
    const events: AgentEvent[] = [];
    const live: Array<{ delta: string; v1Count: number }> = [];
    try {
      const session = peer([
        delta('pi-private-'), delta('credential-abcdefgh'), endMessage(token), { type: 'agent_settled' },
      ]).startSession({ cwd, userPrompt: 'test', timeoutMs: 5_000 }, (event) => {
        events.push(event);
        store.appendEvent(run.id, { ...event });
      }, { onUiEvent(event) {
        if (event.type === 'item.delta') live.push({ delta: event.delta, v1Count: events.filter(e => e.type === 'text').length });
      } });
      await session.result;
      const persisted = store.readEvents(run.id).filter(e => e.type === 'text');
      expect(persisted.map(e => e.text)).toEqual(['[REDACTED]']);
      expect(live).toEqual([
        { delta: 'pi-private-', v1Count: 0 }, { delta: 'credential-abcdefgh', v1Count: 0 },
      ]);
      const disk = readFileSync(join(cwd, 'data', 'runs', `${run.id}.ndjson`), 'utf8');
      expect(disk).not.toContain('pi-private-');
      expect(disk).not.toContain('credential-abcdefgh');
    } finally {
      store.flush();
    }
  });

  it('uses the complete message snapshot once, including text omitted from deltas', async () => {
    const events: AgentEvent[] = [];
    const result = await peer([
      delta('partial'),
      { type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'partial' } },
      endMessage('complete final text'), { type: 'agent_settled' },
    ]).run({ cwd, userPrompt: 'test' }, e => events.push(e));
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', text: 'complete final text' }]);
    expect(result.text).toBe('complete final text');
  });

  it('emits snapshot-only assistant text without including reasoning or user messages', async () => {
    const events: AgentEvent[] = [];
    const result = await peer([
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'user input' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'snapshot only' },
      ] } },
      { type: 'agent_settled' },
    ]).run({ cwd, userPrompt: 'test' }, e => events.push(e));
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', text: 'snapshot only' }]);
    expect(result.text).toBe('snapshot only');
  });

  it('keeps repeated content indices in separate messages and preserves tool order', async () => {
    const events: AgentEvent[] = [];
    await peer([
      delta('first '), delta('message'), endMessage('first message'),
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } },
      { type: 'tool_execution_end', toolCallId: 'tool-1', result: { content: [{ type: 'text', text: 'file' }] } },
      delta('second '), delta('message'), endMessage('second message'), { type: 'agent_settled' },
    ]).run({ cwd, userPrompt: 'test' }, e => events.push(e));
    expect(events.filter(e => ['text', 'tool-call', 'tool-result', 'turn-end'].includes(e.type))).toEqual([
      { type: 'text', text: 'first message' },
      { type: 'tool-call', id: 'tool-1', tool: 'read', input: { path: 'README.md' } },
      { type: 'tool-result', toolCallId: 'tool-1', result: 'file', isError: false },
      { type: 'text', text: 'second message' }, { type: 'turn-end' },
    ]);
  });

  it.each(['EOF', 'interrupt', 'timeout', 'settled'] as const)('flushes unfinished text once on %s', async (boundary) => {
    const events: AgentEvent[] = [];
    const frames = [delta('unfinished '), delta('answer'), ...(boundary === 'settled' ? [{ type: 'agent_settled' }] : [])];
    let session: AgentSession;
    session = peer(frames, boundary === 'interrupt' || boundary === 'timeout').startSession({
      cwd, userPrompt: 'test', timeoutMs: boundary === 'timeout' ? 750 : 5_000,
    }, e => events.push(e), { onUiEvent(e) {
      if (boundary === 'interrupt' && e.type === 'item.delta' && e.delta === 'answer') queueMicrotask(() => session.interrupt());
    } });
    const result = await session.result;
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', text: 'unfinished answer' }]);
    expect(result.text).toBe('unfinished answer');
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    if (boundary === 'settled') expect(events.findIndex(e => e.type === 'text')).toBeLessThan(events.findIndex(e => e.type === 'turn-end'));
    if (boundary === 'timeout') expect(events.some(e => e.type === 'error' && e.message.includes('timed out'))).toBe(true);
  });
});

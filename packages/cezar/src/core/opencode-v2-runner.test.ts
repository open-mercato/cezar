import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

const bin = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/opencode/mock-opencode-v2-serve.mjs');
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { session.end(); await session.result; }
});

function start(prompt: string, autoEnd = true, env?: Record<string, string>) {
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  const session = new OpencodeServerRunner({ bin, timeoutMs: 15_000 }).startSession({
    userPrompt: prompt, systemPrompt: 'SYSTEM', cwd: process.cwd(), model: 'mock/mock-model#high', env,
  }, (event) => events.push(event), { autoEndAfterFirstTurn: autoEnd, onUiEvent: (event) => ui.push(event) });
  sessions.push(session);
  return { session, events, ui };
}

describe('OpenCode V1 + V2 runner compatibility', () => {
  it('authenticates V2 HTTP and SSE and preserves text/tools/usage in both event protocols', async () => {
    const { session, events, ui } = start('hello');
    const result = await session.result;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(result.sessionId).toBe('ses_v2_mock');
    expect(result.text).toContain('SYSTEM');
    expect(result.text).toContain('hello');
    expect(result.tokensUsed).toBe(120);
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'shell', input: { command: 'git status' } }]);
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
    expect(ui).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ name: 'shell', output: 'clean' }) }));
  });

  it('does not interpret an asynchronous V2 acknowledgement as idle during quiet work', async () => {
    const { session, events } = start('long tool #quiet');
    const result = await session.result;
    expect(result.text).toContain('long tool #quiet');
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
  }, 20_000);

  it('keeps the V2 session and model for follow-up turns', async () => {
    const { session, events, ui } = start('first', false);
    await expect.poll(() => events.filter((e) => e.type === 'turn-end').length).toBe(1);
    expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
    await expect.poll(() => events.filter((e) => e.type === 'turn-end').length).toBe(2);
    session.end();
    const result = await session.result;
    expect(result.text).toContain('Turn 2: second');
    expect(result.tokensUsed).toBe(240);
    expect(events.filter((e) => e.type === 'cost').reduce((total, e) => total + e.usd, 0)).toBeCloseTo(0.02);
    expect(ui.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(ui.filter((e) => e.type === 'turn.completed')).toHaveLength(2);
  });

  it('owns private authentication even when a parent supplies OPENCODE_PASSWORD', async () => {
    const { session, events } = start('hello', true, { OPENCODE_PASSWORD: 'fixture-parent-password' });
    const result = await session.result;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(result.text).toContain('hello');
  });

  it('waits for native idle after V2 wait transport loss, never a quiet grace window', async () => {
    const { session, events } = start('long tool #quiet #wait-drop');
    const result = await session.result;
    expect(result.text).toContain('long tool #quiet #wait-drop');
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
  }, 20_000);

  it('has a bounded, normalized turn exit if V2 wait succeeds but idle is missing', async () => {
    const { session, events, ui } = start('#no-idle');
    const result = await session.result;
    expect(result.text).toContain('#no-idle');
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
    expect(ui.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
  }, 20_000);

  it('surfaces native V2 execution failures in both protocols', async () => {
    const { session, events, ui } = start('#error');
    await session.result;
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'opencode: invalid API key' }]);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it('terminates instead of hanging or silently succeeding when the V2 event bus dies', async () => {
    const { session, events } = start('#stream-loss');
    const result = await session.result;
    expect(result.text).toBe('');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('event stream') }));
  });

  it('refuses to launch V2 work without an event stream', async () => {
    const { session, events } = start('hello', true, { MOCK_NO_EVENT_BUS: '1' });
    await session.result;
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('event stream') }));
  });

  it('does not downgrade authentication failures into V1', async () => {
    const { session, events } = start('hello', true, { MOCK_V2_PROBE_UNAUTHORIZED: '1' });
    await session.result;
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'opencode: GET /api/info → 401' }));
  });

  it('cancels a V2 turn while its asynchronous wait is still pending', async () => {
    const { session, events } = start('#quiet', false);
    await expect.poll(() => events.some((e) => e.type === 'session')).toBe(true);
    session.interrupt();
    await session.result;
    expect(session.open).toBe(false);
    expect(events.filter((e) => e.type === 'turn-end').length).toBeLessThanOrEqual(1);
  });

  describe('session tree teardown (#2468)', () => {
    function treeLog(): { file: string; read: () => string[] } {
      const dir = mkdtempSync(join(tmpdir(), 'oc-tree-'));
      const file = join(dir, 'calls.log');
      return { file, read: () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) };
    }

    it('aborts the root and every descendant on interrupt, and never touches a foreign session', async () => {
      const log = treeLog();
      const { session, events } = start('#quiet', false, { MOCK_TREE_LOG: log.file });
      await expect.poll(() => events.some((e) => e.type === 'session')).toBe(true);
      session.interrupt();
      await session.result;
      const calls = log.read();
      expect(calls).toEqual(expect.arrayContaining(['ses_v2_mock', 'ses_child_1', 'ses_grandchild']));
      expect(calls).not.toContain('ses_user_same_dir');
      expect(calls).not.toContain('ses_other_dir');
      rmSync(dirname(log.file), { recursive: true, force: true });
    });

    it('keeps the server alive for a slow drain when bootstrap fails after an early interrupt', async () => {
      const log = treeLog();
      // Interrupt inside the `session` event itself, before the event stream connects, so the
      // bootstrap's own failure reaches teardown while the (slow) drain is still listing children.
      let interrupt = (): void => undefined;
      const session = new OpencodeServerRunner({ bin, timeoutMs: 15_000 }).startSession({
        userPrompt: '#quiet', systemPrompt: 'SYSTEM', cwd: process.cwd(), model: 'mock/mock-model#high',
        env: { MOCK_TREE_LOG: log.file, MOCK_TREE_DELAY_MS: '300' },
      }, (event) => { if (event.type === 'session') interrupt(); }, { autoEndAfterFirstTurn: false });
      interrupt = () => session.interrupt();
      await session.result;
      expect(log.read()).toEqual(expect.arrayContaining(['ses_v2_mock', 'ses_child_1', 'ses_grandchild']));
      rmSync(dirname(log.file), { recursive: true, force: true });
    });

    it('aborts the tree on a normal end() too, before the server is killed', async () => {
      const log = treeLog();
      const { session } = start('hello', true, { MOCK_TREE_LOG: log.file });
      await session.result;
      expect(log.read()).toEqual(expect.arrayContaining(['ses_child_1', 'ses_grandchild']));
      rmSync(dirname(log.file), { recursive: true, force: true });
    });

    it('interrupts only this task\'s own earlier cezar roots at startup — not foreign sessions', async () => {
      const log = treeLog();
      const { session, events } = start('#quiet', false, { MOCK_TREE_LOG: log.file });
      await expect.poll(() => events.some((e) => e.type === 'session')).toBe(true);
      const calls = log.read();
      expect(calls).toContain('ses_old_same_dir');
      expect(calls).not.toContain('ses_user_same_dir');
      expect(calls).not.toContain('ses_other_dir');
      session.end();
      await session.result;
      rmSync(dirname(log.file), { recursive: true, force: true });
    });

    it('degrades quietly when the server has no session listing', async () => {
      const { session, events } = start('hello', true, { MOCK_NO_TREE: '1' });
      const result = await session.result;
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(result.text).toContain('hello');
    });
  });
});

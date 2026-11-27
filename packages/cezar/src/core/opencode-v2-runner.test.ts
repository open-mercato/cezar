import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { isOpencodeMissingSessionError, OpencodeServerRunner } from './opencode-server-runner.ts';

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

  describe('reopening a V2 session on resume (#2543)', () => {
    function resume(sessionId: string) {
      const dir = mkdtempSync(join(tmpdir(), 'oc-v2-resume-'));
      const file = join(dir, 'requests.log');
      const events: AgentEvent[] = [];
      const session = new OpencodeServerRunner({ bin, timeoutMs: 15_000 }).startSession({
        userPrompt: 'continue the task', systemPrompt: 'SYSTEM', cwd: process.cwd(), sessionId, resume: true,
        env: { MOCK_REQUESTS_FILE: file },
      }, (event) => events.push(event), { autoEndAfterFirstTurn: true });
      sessions.push(session);
      const requests = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
      return { session, events, requests, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    it('reopens the saved session instead of creating one, after settling earlier task sessions', async () => {
      const { session, events, requests, cleanup } = resume('ses_v2_mock');
      const result = await session.result;
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(result.sessionId).toBe('ses_v2_mock');
      expect(result.text).toContain('continue the task');
      expect(result.text).toContain('SYSTEM');
      const sent = requests();
      expect(sent).toContain('GET /api/session/ses_v2_mock');
      expect(sent).not.toContain('POST /api/session');
      // A claim the server restarted on its own is interrupted before the reopened session is driven (#2468).
      expect(sent.indexOf('POST /api/session/ses_old_same_dir/interrupt')).toBeGreaterThanOrEqual(0);
      expect(sent.indexOf('POST /api/session/ses_old_same_dir/interrupt')).toBeLessThan(sent.indexOf('GET /api/session/ses_v2_mock'));
      cleanup();
    });

    it.each([
      ['the server no longer has', 'ses_gone'],
      ['belongs to another directory', 'ses_moved_away'],
    ])('a session that %s fails with the missing-session marker and posts no prompt', async (_why, id) => {
      const { session, events, requests, cleanup } = resume(id);
      await session.result;
      const errors = events.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(isOpencodeMissingSessionError(errors[0]!.message)).toBe(true);
      expect(events.some((e) => e.type === 'session')).toBe(false);
      expect(requests().some((line) => line.endsWith('/prompt'))).toBe(false);
      cleanup();
    });
  });
});

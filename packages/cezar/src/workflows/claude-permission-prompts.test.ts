import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import { CLAUDE_PERMISSION_ASK_PREFIX } from '../core/claude-permission-prompt.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false'];

/** What the mocked Claude runner saw, and the knobs a test turns on the session it hands back. */
const ctl = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  opts: [] as Array<SessionOptions | undefined>,
  sessions: [] as Array<{
    sendMessage: ReturnType<typeof vi.fn>;
    respondPermission: ReturnType<typeof vi.fn>;
    end: () => void;
  }>,
  /** The session settles at once (a finished task) instead of staying open for the test. */
  autoFinish: true,
  /** What `respondPermission` answers: true = the prompt was pending and is now written to the CLI. */
  answerOk: true,
  /** What `hasPendingPermission` answers. */
  pending: false,
  /** Per-request form: when set, `hasPendingPermission(id)` answers for exactly these ids. */
  pendingIds: undefined as Set<string> | undefined,
}));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts?: SessionOptions) => {
      ctl.specs.push(spec);
      ctl.opts.push(opts);
      let settle!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>((resolve) => { settle = resolve; });
      let open = true;
      const finish = () => { open = false; settle({ text: 'ok', toolCalls: [], tokensUsed: 0 }); };
      const session = {
        result,
        sendMessage: vi.fn(() => true),
        respondPermission: vi.fn(() => ctl.answerOk),
        hasPendingPermission: (id?: string) => ctl.pendingIds
          ? (id === undefined ? ctl.pendingIds.size > 0 : ctl.pendingIds.has(id))
          : ctl.pending,
        end: finish,
        interrupt: () => {},
        get open() { return open; },
      };
      ctl.sessions.push(session);
      const n = ctl.specs.length;
      setTimeout(() => {
        onEvent?.({ type: 'session', sessionId: `sess-${n}` });
        if (ctl.autoFinish) finish();
      }, 0);
      return session;
    },
    interrupt: async () => {},
  }),
}));

const ASK_ID = `${CLAUDE_PERMISSION_ASK_PREFIX}req-1`;
const permissionCard = (requestId: string) => ({
  type: 'ask.requested' as const,
  requestId,
  questions: [{
    header: 'Permission',
    question: 'Claude wants to run: npm test',
    options: [{ label: 'Allow once' }, { label: 'Reject' }],
  }],
});

describe('Claude permission prompts answered from the cockpit', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const QUICK: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

  beforeEach(async () => {
    ctl.specs.length = 0;
    ctl.opts.length = 0;
    ctl.sessions.length = 0;
    ctl.autoFinish = true;
    ctl.answerOk = true;
    ctl.pending = false;
    ctl.pendingIds = undefined;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-claude-permission-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    store?.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const setMode = (mode: unknown) => writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ claudePermissionMode: mode }));
  const start = async (input: { readOnly?: true } = {}) => {
    const record = manager.startRun(QUICK, { task: 'do it', runner: 'claude', ...input });
    await vi.waitFor(() => expect(ctl.specs).toHaveLength(1), { timeout: 15_000 });
    return record.id;
  };
  const settled = (id: string) =>
    vi.waitFor(() => expect(['done', 'review']).toContain(store.getRun(id)?.status), { timeout: 15_000 });
  /** A live task with its permission card open: the run is parked `waiting` on it. */
  const parkedOnPrompt = async (requestId = ASK_ID) => {
    ctl.autoFinish = false;
    const id = await start();
    ctl.opts[0]!.onUiEvent!(permissionCard(requestId));
    await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 15_000 });
    return id;
  };
  const askOf = (id: string, requestId = ASK_ID) => store.getRun(id)?.asks?.find((ask) => ask.requestId === requestId);
  const closedEvents = (id: string, requestId = ASK_ID) =>
    store.readEvents(id).filter((event) => (event as { type?: string; requestId?: string }).type === 'ask.closed' && (event as { requestId?: string }).requestId === requestId);
  const text = (value: string) => [{ type: 'text' as const, text: value }];

  describe('the spec the runner receives', () => {
    it('is absent by default', async () => {
      await start();
      expect(ctl.specs[0]!.claudePermissionMode).toBeUndefined();
    });

    it.each(['manual', 'acceptEdits'] as const)('carries %s on a new task and on Continue', async (mode) => {
      setMode(mode);
      const id = await start();
      expect(ctl.specs[0]!.claudePermissionMode).toBe(mode);
      await settled(id);
      expect(manager.continueRun(id, { text: 'and then?' })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(ctl.specs).toHaveLength(2), { timeout: 15_000 });
      expect(ctl.specs[1]!.claudePermissionMode).toBe(mode);
    });

    it('is never sent for a read-only task', async () => {
      setMode('manual');
      await start({ readOnly: true });
      expect(ctl.specs[0]!.claudePermissionMode).toBeUndefined();
    });

    it('ignores a value the config schema does not know', async () => {
      setMode('auto');
      await start();
      expect(ctl.specs[0]!.claudePermissionMode).toBeUndefined();
    });
  });

  describe('answering a permission card', () => {
    it('hands the raw text to the session out of band, closes the card and un-parks the run', async () => {
      const id = await parkedOnPrompt();
      expect(askOf(id)).toBeDefined();
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(true);
      const session = ctl.sessions[0]!;
      expect(session.respondPermission).toHaveBeenCalledExactlyOnceWith(ASK_ID, 'Permission: Allow once');
      // Never a user turn: no open-questions block, no composed message.
      expect(session.sendMessage).not.toHaveBeenCalled();
      expect(askOf(id)?.closed).toMatchObject({ reason: 'answered', answer: 'Permission: Allow once' });
      expect(closedEvents(id)).toHaveLength(1);
      expect(store.getRun(id)).toMatchObject({ status: 'running' });
      expect(store.getRun(id)?.attentionRequest).toBeUndefined();
    });

    it('refuses a stale answer: closes the card as expired, never a prompt and never a session', async () => {
      const id = await parkedOnPrompt();
      ctl.answerOk = false;
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(false);
      expect(ctl.sessions[0]!.sendMessage).not.toHaveBeenCalled();
      expect(askOf(id)?.closed).toMatchObject({ reason: 'expired', detail: 'the permission prompt is no longer pending' });
      expect(closedEvents(id)).toHaveLength(1);
      expect(store.getRun(id)?.status).toBe('waiting');
      expect(ctl.specs).toHaveLength(1);
    });

    it('does not reopen a finished run for a stale answer', async () => {
      const id = await start();
      await settled(id);
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(false);
      expect(manager.deferMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(false);
      expect(ctl.specs).toHaveLength(1);
    });

    it('a Continue that answers a permission card is refused, not turned into the opening prompt', async () => {
      const id = await parkedOnPrompt();
      ctl.sessions[0]!.end();
      await vi.waitFor(() => expect(store.getRun(id)?.status).not.toBe('waiting'), { timeout: 15_000 });
      await settled(id);
      const result = manager.continueRun(id, { text: 'Permission: Allow once', reply: { askRequestId: ASK_ID } });
      expect(result.ok).toBe(false);
      expect(ctl.specs).toHaveLength(1);
      expect(askOf(id)?.closed).toBeDefined();
    });

    it('two prompts at once stay two open cards: neither replaces nor flags the other', async () => {
      const id = await parkedOnPrompt();
      const second = `${CLAUDE_PERMISSION_ASK_PREFIX}req-2`;
      ctl.opts[0]!.onUiEvent!(permissionCard(second));
      for (const requestId of [ASK_ID, second]) {
        expect(askOf(id, requestId)).toBeDefined();
        expect(askOf(id, requestId)?.closed).toBeUndefined();
        expect(askOf(id, requestId)?.stale).toBeUndefined();
      }
      ctl.pending = true;
      expect(manager.sendMessage(id, text('Permission: Reject'), { askRequestId: ASK_ID })).toBe(true);
      expect(askOf(id)?.closed?.reason).toBe('answered');
      expect(askOf(id, second)?.closed).toBeUndefined();
      // The other prompt is still pending: the run stays parked on it.
      expect(store.getRun(id)?.status).toBe('waiting');
    });
  });

  describe('a message that is not the answer', () => {
    it('leaves the run parked while the permission prompt is still open', async () => {
      const id = await parkedOnPrompt();
      ctl.pending = true;
      expect(manager.sendMessage(id, text('are you there?'))).toBe(true);
      expect(ctl.sessions[0]!.sendMessage).toHaveBeenCalledTimes(1);
      expect(store.getRun(id)?.status).toBe('waiting');
      expect(store.getRun(id)?.attentionRequest?.requestId).toBe(ASK_ID);
    });

    it('un-parks as usual once no prompt is pending', async () => {
      const id = await parkedOnPrompt();
      ctl.pending = false;
      expect(manager.sendMessage(id, text('carry on'))).toBe(true);
      expect(store.getRun(id)?.status).toBe('running');
    });
  });

  describe('the runner withdrawing a prompt', () => {
    it('closes the task card (once) with the runner reason', async () => {
      const id = await parkedOnPrompt();
      ctl.opts[0]!.onUiEvent!({ type: 'ask.closed', requestId: ASK_ID, reason: 'retracted', detail: 'Claude withdrew the request' });
      expect(askOf(id)?.closed).toMatchObject({ reason: 'retracted', detail: 'Claude withdrew the request' });
      expect(closedEvents(id)).toHaveLength(1);
    });

    it('goes back to running when the retracted prompt was the last one and the session lives on', async () => {
      const id = await parkedOnPrompt();
      ctl.pending = false;
      ctl.opts[0]!.onUiEvent!({ type: 'ask.closed', requestId: ASK_ID, reason: 'retracted' });
      expect(store.getRun(id)?.status).toBe('running');
    });

    it('stays parked when another prompt is still pending', async () => {
      const id = await parkedOnPrompt();
      ctl.pending = true;
      ctl.opts[0]!.onUiEvent!({ type: 'ask.closed', requestId: ASK_ID, reason: 'retracted' });
      expect(store.getRun(id)?.status).toBe('waiting');
    });

    it('does not touch a question that is not a permission prompt', async () => {
      const id = await parkedOnPrompt();
      ctl.opts[0]!.onUiEvent!({ type: 'ask.closed', requestId: 'other-ask', reason: 'retracted' });
      expect(askOf(id)?.closed).toBeUndefined();
    });
  });

  describe('dismissing the card from the Questions inbox', () => {
    it('rejects the prompt instead of telling the agent in chat, and the run works again', async () => {
      const id = await parkedOnPrompt();
      expect(manager.dismissAsk(id, ASK_ID)).toMatchObject({ ok: true });
      expect(ctl.sessions[0]!.respondPermission).toHaveBeenCalledWith(ASK_ID, 'Permission: Reject');
      expect(ctl.sessions[0]!.sendMessage).not.toHaveBeenCalled();
      expect(askOf(id)?.closed?.reason).toBe('dismissed');
      expect(closedEvents(id)).toHaveLength(1);
      expect(store.getRun(id)?.status).toBe('running');
    });

    it('leaves the card open and answers 409 when the live prompt could not be rejected', async () => {
      const id = await parkedOnPrompt();
      ctl.answerOk = false;
      ctl.pending = true;
      expect(manager.dismissAsk(id, ASK_ID)).toMatchObject({ ok: false, status: 409 });
      expect(askOf(id)?.closed).toBeUndefined();
      expect(closedEvents(id)).toHaveLength(0);
      expect(store.getRun(id)?.status).toBe('waiting');
    });

    it('dismisses a stale card while another prompt stays pending, and the run stays parked on that one', async () => {
      const id = await parkedOnPrompt();
      const other = `${CLAUDE_PERMISSION_ASK_PREFIX}req-2`;
      ctl.opts[0]!.onUiEvent!(permissionCard(other));
      ctl.pendingIds = new Set([other]);
      ctl.answerOk = false;
      expect(manager.dismissAsk(id, ASK_ID)).toMatchObject({ ok: true, delivered: 'none' });
      expect(askOf(id)?.closed?.reason).toBe('dismissed');
      expect(askOf(id, other)?.closed).toBeUndefined();
      expect(store.getRun(id)?.status).toBe('waiting');
      expect(store.getRun(id)?.attentionRequest?.requestId).toBe(other);
    });

    it('just closes a card whose prompt is gone', async () => {
      const id = await parkedOnPrompt();
      ctl.answerOk = false;
      ctl.pending = false;
      expect(manager.dismissAsk(id, ASK_ID)).toMatchObject({ ok: true, delivered: 'none' });
      expect(askOf(id)?.closed?.reason).toBe('dismissed');
    });
  });

  describe('a card is only closed as expired when no live prompt is pending', () => {
    it('a lifecycle block refuses an answer without closing the card', async () => {
      const id = await parkedOnPrompt();
      vi.spyOn((manager as unknown as { lifecycle: { isBlocked: (runId: string) => boolean } }).lifecycle, 'isBlocked').mockReturnValue(true);
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(false);
      expect(ctl.sessions[0]!.respondPermission).not.toHaveBeenCalled();
      expect(askOf(id)?.closed).toBeUndefined();
    });

    it('a Continue naming the card is refused without closing it while the prompt is live', async () => {
      const id = await parkedOnPrompt();
      ctl.pending = true;
      expect(manager.continueRun(id, { text: 'Permission: Allow once', reply: { askRequestId: ASK_ID } }).ok).toBe(false);
      expect(askOf(id)?.closed).toBeUndefined();
    });

    it('an answer for a stale card closes it as expired while another prompt stays pending and the run stays parked', async () => {
      const id = await parkedOnPrompt();
      const other = `${CLAUDE_PERMISSION_ASK_PREFIX}req-2`;
      ctl.opts[0]!.onUiEvent!(permissionCard(other));
      ctl.pendingIds = new Set([other]);
      ctl.answerOk = false;
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(false);
      expect(askOf(id)?.closed).toMatchObject({ reason: 'expired' });
      expect(askOf(id, other)?.closed).toBeUndefined();
      expect(store.getRun(id)?.status).toBe('waiting');
      expect(store.getRun(id)?.attentionRequest?.requestId).toBe(other);
    });

    it('a Continue naming a stale card closes it while another prompt is pending', async () => {
      const id = await parkedOnPrompt();
      const other = `${CLAUDE_PERMISSION_ASK_PREFIX}req-2`;
      ctl.opts[0]!.onUiEvent!(permissionCard(other));
      ctl.pendingIds = new Set([other]);
      expect(manager.continueRun(id, { text: 'Permission: Allow once', reply: { askRequestId: ASK_ID } }).ok).toBe(false);
      expect(askOf(id)?.closed).toMatchObject({ reason: 'expired' });
      expect(askOf(id, other)?.closed).toBeUndefined();
    });

    it('a Continue naming a live card says to try again instead of calling the prompt gone', async () => {
      const id = await parkedOnPrompt();
      ctl.pendingIds = new Set([ASK_ID]);
      const result = manager.continueRun(id, { text: 'Permission: Allow once', reply: { askRequestId: ASK_ID } });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/try again/);
      expect(result.error).not.toMatch(/no longer pending/);
      expect(askOf(id)?.closed).toBeUndefined();
    });

    it('attention never moves to a card whose prompt is not pending', async () => {
      const id = await parkedOnPrompt();
      const stale = `${CLAUDE_PERMISSION_ASK_PREFIX}req-stale`;
      ctl.opts[0]!.onUiEvent!(permissionCard(stale));
      // The head is answered; another prompt is still pending, but no open card is that one.
      ctl.pendingIds = new Set([`${CLAUDE_PERMISSION_ASK_PREFIX}req-hidden`]);
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(true);
      expect(store.getRun(id)?.attentionRequest?.requestId).not.toBe(stale);
    });

    it('dismiss answers 409 and keeps the card when that very prompt is pending but cannot be rejected', async () => {
      const id = await parkedOnPrompt();
      ctl.pendingIds = new Set([ASK_ID]);
      ctl.answerOk = false;
      expect(manager.dismissAsk(id, ASK_ID)).toMatchObject({ ok: false, status: 409 });
      expect(askOf(id)?.closed).toBeUndefined();
      expect(closedEvents(id)).toHaveLength(0);
    });

    it('a live card is never closed by a refused answer', async () => {
      const id = await parkedOnPrompt();
      ctl.pendingIds = new Set([ASK_ID]);
      ctl.answerOk = false;
      expect(manager.sendMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBe(false);
      expect(askOf(id)?.closed).toBeUndefined();
    });
  });

  describe('the agent never hears about permission cards', () => {
    it('a composer message neither flags the card as replied-in-chat nor lists it as an open question', async () => {
      const id = await parkedOnPrompt();
      ctl.pending = true;
      expect(manager.sendMessage(id, text('are you there?'))).toBe(true);
      expect(askOf(id)?.stale).toBeUndefined();
      const sent = JSON.stringify(ctl.sessions[0]!.sendMessage.mock.calls);
      expect(sent).not.toMatch(/open questions/i);
    });
  });

  describe('the order the card appears in', () => {
    it('the task card is tracked before any client sees its ask.requested event', async () => {
      ctl.autoFinish = false;
      const id = await start();
      let trackedAtEvent: boolean | undefined;
      store.on('event', (payload: { runId: string; event: { type?: string; requestId?: string } }) => {
        if (payload.runId === id && payload.event.type === 'ask.requested' && payload.event.requestId === ASK_ID) {
          trackedAtEvent = askOf(id) !== undefined;
        }
      });
      ctl.opts[0]!.onUiEvent!(permissionCard(ASK_ID));
      expect(trackedAtEvent).toBe(true);
    });
  });

  describe('a queued run', () => {
    it('never stacks a permission answer onto its prompt', async () => {
      const id = await parkedOnPrompt();
      vi.spyOn(manager as unknown as { isQueued: (runId: string) => boolean }, 'isQueued').mockReturnValue(true);
      expect(manager.enqueueMessage(id, text('Permission: Allow once'), { askRequestId: ASK_ID })).toBeNull();
      expect(manager.enqueueMessage(id, text('a plain follow-up'))).not.toBeNull();
    });
  });
});

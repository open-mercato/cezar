import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId, SessionOptions } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { RunStore } from '../runs/store.ts';
import * as profiles from '../workspace/agent-profiles.ts';
import { AUTO_RESUME_GRACE_MS, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const sessions = vi.hoisted(() => [] as { backend: RunnerId; prompt: string; emit: (event: AgentEvent) => void; ui: (event: UiEvent) => void; end: () => void }[]);
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: RunnerId) => ({
    startSession: (spec: AgentRunSpec, onEvent: (event: AgentEvent) => void, opts: SessionOptions) => {
      if (spec.userPrompt === 'throw') throw new Error('launch failed');
      let finish: () => void = () => {};
      let open = true;
      const result = new Promise<AgentRunResult>((resolve) => {
        finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      });
      sessions.push({ backend, prompt: spec.userPrompt, emit: onEvent, ui: opts.onUiEvent!, end: finish });
      return { result, get open() { return open; }, sendMessage: () => true, end: finish, interrupt: finish };
    },
  }),
}));

const TASK: WorkflowDef = { name: 'one-step', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }] };
const LIMIT = 'Codex usage limit reached. Try again in 3 hours.';

describe('council session ownership', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string;
  type State = {
    currentStepId?: string;
    usageLimitedAccount?: string;
    usageLimitedMessage?: string;
    usageLimitedAt?: number;
    unprovenSessions?: Map<string, Set<unknown>>;
  };
  let internals: {
    active: Map<string, State>;
    runAgentStep: (...args: unknown[]) => Promise<string | null>;
    scheduleAutoResumeIfLimited: (id: string, account?: string, message?: string, capturedAt?: number) => void;
  };
  let state: State;

  beforeEach(async () => {
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-council-accounts-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    runId = manager.startRun(TASK, { task: 'hold', runner: 'claude', worktree: false }).id;
    await expect.poll(() => sessions.length, { timeout: 5_000 }).toBe(1);
    internals = manager as unknown as typeof internals;
    state = internals.active.get(runId)!;
    store.updateRun(runId, { harness: { workflow: 'harness-fix-issue', profile: 'multi', issueId: '1' } });
    store.addStep(runId, { id: 'council', name: 'Council', kind: 'agent' });
    vi.spyOn(profiles, 'resolveProfileEnvForRoot').mockImplementation(async (_, provider) => ({
      profile: { ...profiles.defaultAgentProfile(provider), id: 'resolved-work' }, env: {},
    }));
  });

  afterEach(async () => {
    manager.cancel(runId);
    await expect.poll(() => manager.isActive(runId)).toBe(false);
    manager.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  function phase(backend: RunnerId, prompt: string = backend, concurrent = true) {
    const resultPath = join(root, `${backend}.json`);
    writeFileSync(resultPath, '{}');
    return internals.runAgentStep(runId, state, { id: 'council', prompt, runner: backend },
      { task: 'x', worktree: false }, [], null, false,
      (event: { type: string; [key: string]: unknown }) => store.appendEvent(runId, event),
      undefined, 'claude', undefined, undefined, [], undefined,
      { concurrent, resultPath, timeoutMs: 20_000 });
  }

  async function failRun(message: string, session = sessions[0]!) {
    session.emit({ type: 'error', message });
    session.end();
    await expect.poll(() => manager.isActive(runId)).toBe(false);
    expect(store.getRun(runId)?.status).toBe('failed');
  }

  async function restart() {
    const sessionCount = sessions.length;
    manager.dispose();
    sessions[0]!.end();
    store.flush({ throwOnError: true });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root);
    internals = manager as unknown as typeof internals;
    await manager.recover();
    await expect.poll(() => sessions.length, { timeout: 5_000 }).toBe(sessionCount + 1);
    state = internals.active.get(runId)!;
    return sessions[sessionCount]!;
  }

  const resetlessLimits = [
    { backend: 'opencode' as const, message: 'opencode: usage limit reached: quota exhausted' },
    { backend: 'codex' as const, message: 'Rate limit reached. Please try again in 1.2s' },
  ];
  const RESETLESS = "You've hit your usage limit. Try again in 2 days 3 hours.";

  it.each([false, true])('keeps a reset-less Codex limit from being proven by an in-flight sibling (other capture=%s)', async (otherCapture) => {
    store.updateRun(runId, { autoResumeAttempts: 1, autoResumeAccount: 'codex:default' });
    const limited = phase('codex', 'limited');
    await expect.poll(() => sessions.length).toBe(2);
    const sibling = phase('codex', 'sibling');
    await expect.poll(() => sessions.length).toBe(3);
    if (otherCapture) {
      const claude = phase('claude');
      await expect.poll(() => sessions.length).toBe(4);
      sessions[3]!.emit({ type: 'error', message: 'Claude usage limit reached. Try again in 3 hours.' });
      await claude;
    }
    sessions[1]!.emit({ type: 'error', message: RESETLESS });
    expect(await limited).toBe(RESETLESS);
    sessions[2]!.emit({ type: 'turn-end' });
    await sibling;
    expect(store.getRun(runId)?.autoResumeAttempts).toBe(1);
    expect(store.getRun(runId)?.autoResumeAccount).toBe('codex:default');
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));

    const nextIndex = sessions.length;
    const proof = phase('codex', 'proof');
    await expect.poll(() => sessions.length).toBe(nextIndex + 1);
    sessions[nextIndex]!.emit({ type: 'turn-end' });
    await proof;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBe(otherCapture ? 'claude:default' : undefined);
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each([false, true])('guard: a reset-less and a resettable limit schedule the resettable account in either order (reset-less first=%s)', async (resetlessFirst) => {
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(3);
    const reset = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    const claudeLimit = `Claude AI usage limit reached|${reset / 1000}`;
    const failures = [
      async () => { sessions[1]!.emit({ type: 'error', message: RESETLESS }); expect(await codex).toBe(RESETLESS); },
      async () => { sessions[2]!.emit({ type: 'error', message: claudeLimit }); expect(await claude).toBe(claudeLimit); },
    ];
    if (!resetlessFirst) failures.reverse();
    for (const fail of failures) await fail();
    expect(state.usageLimitedAccount).toBe('claude:default');
    await failRun(`council below quorum: ${RESETLESS}\n${claudeLimit}`);
    expect(store.getRun(runId)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect(manager.accountHolds().deadline).toEqual(new Set(['claude:default']));
    expect(state.unprovenSessions?.size ?? 0).toBe(0);
  });

  it('guard: a sequential phase limit holds its account until a proven turn', async () => {
    store.updateRun(runId, { autoResumeAttempts: 1, autoResumeAccount: 'codex:default' });
    const limited = phase('codex', 'implement', false);
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    expect(await limited).toBe(LIMIT);
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));
    const proof = phase('codex', 'retry', false);
    await expect.poll(() => sessions.length).toBe(3);
    expect(state.unprovenSessions?.size ?? 0).toBe(0);
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));
    sessions[2]!.emit({ type: 'turn-end' });
    await proof;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it('guard: a resume limited again reschedules with attempts=1', async () => {
    store.updateRun(runId, { autoResumeAttempts: 1, autoResumeAccount: 'codex:default' });
    const limited = phase('codex', 'retry', false);
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    expect(await limited).toBe(LIMIT);
    await failRun(`council below quorum: ${LIMIT}`);
    expect(store.getRun(runId)).toMatchObject({ autoResumeAttempts: 1, autoResumeAccount: 'codex:default' });
    expect(store.getRun(runId)?.autoResumeAt).toBeDefined();
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it('guard: a sequential phase clears a reset-less capture round', async () => {
    const limited = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: RESETLESS });
    await limited;
    const next = phase('claude', 'implement', false);
    await expect.poll(() => sessions.length).toBe(3);
    expect(state.unprovenSessions?.size ?? 0).toBe(0);
    sessions[2]!.emit({ type: 'turn-end' });
    await next;
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
  });

  it.each(resetlessLimits)('uses a later Claude reset after a reset-less $backend reviewer fails', async ({ backend, message }) => {
    const first = phase(backend);
    await expect.poll(() => sessions.length).toBe(2);
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(3);
    const reset = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    const claudeLimit = `Claude AI usage limit reached|${reset / 1000}`;
    sessions[1]!.emit({ type: 'error', message });
    expect(await first).toBe(message);
    sessions[2]!.emit({ type: 'error', message: claudeLimit });
    expect(await claude).toBe(claudeLimit);
    await failRun(`council below quorum: ${message}\n${claudeLimit}`);
    expect.soft(store.getRun(runId)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect.soft(store.getRun(runId)?.autoResumeAccount).toBe('claude:default');
    expect(manager.accountHolds().deadline).toEqual(new Set(['claude:default']));
  });

  it.each(resetlessLimits)('guard: a lone reset-less $backend limit schedules nothing', async ({ backend, message }) => {
    const reviewer = phase(backend);
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message });
    expect(await reviewer).toBe(message);
    await failRun(`council below quorum: ${message}`);
    expect(store.getRun(runId)?.autoResumeAt).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each(['running', 'waiting'] as const)('forgets a degraded capture after restarting a %s run before an advisor limit', async (status) => {
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await reviewer;
    expect(store.getRun(runId)?.autoResumeAccount).toBe('codex:default');
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    store.updateRun(runId, { status });
    const resumed = await restart();
    expect(state.unprovenSessions?.size ?? 0).toBe(0);
    expect.soft(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    const implement = phase('claude', 'implement', false);
    await expect.poll(() => sessions.length).toBe(4);
    sessions[3]!.emit({ type: 'turn-end' });
    await implement;
    const reset = Math.floor((Date.now() + 2 * 3_600_000) / 1000) * 1000;
    await failRun(`advisor failed: Claude AI usage limit reached|${reset / 1000}`, resumed);
    expect(store.getRun(runId)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect.soft(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each([0, 1])('guard: a resume in flight keeps its account across restart (attempts=%s)', async (attempts) => {
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await reviewer;
    store.updateRun(runId, { autoResumeAttempts: attempts });
    await restart();
    expect(state.unprovenSessions?.size ?? 0).toBe(0);
    expect(store.getRun(runId)).toMatchObject({ autoResumeAccount: 'codex:default', autoResumeAttempts: attempts });
    const implement = phase('claude', 'implement', false);
    await expect.poll(() => sessions.length).toBe(4);
    sessions[3]!.emit({ type: 'turn-end' });
    await implement;
    expect(store.getRun(runId)).toMatchObject({ autoResumeAccount: 'codex:default', autoResumeAttempts: attempts });
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));
    const proof = phase('codex', 'proof');
    await expect.poll(() => sessions.length).toBe(5);
    sessions[4]!.emit({ type: 'turn-end' });
    await proof;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each([false, true])('expires a degraded council limit before an unrelated failure (next phase=%s)', async (nextPhase) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T23:41:00Z'));
    const reviewer = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: "You've hit your session limit · resets 0:11 (UTC)" });
    await reviewer;
    vi.setSystemTime(new Date('2026-10-27T02:41:00Z'));
    if (nextPhase) {
      const implement = phase('codex', 'implement', false);
      await expect.poll(() => sessions.length).toBe(3);
      expect(state.usageLimitedMessage).toBeUndefined();
      expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
      sessions[2]!.emit({ type: 'turn-end' });
      await implement;
    }
    await failRun('implement phase failed: tests are red');
    expect(store.getRun(runId)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it('holds a later sequential Codex limit instead of a degraded Claude capture', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T23:41:00Z'));
    const reviewer = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: "You've hit your session limit · resets 0:11 (UTC)" });
    await reviewer;
    vi.setSystemTime(new Date('2026-10-27T02:41:00Z'));
    const implement = phase('codex', 'implement', false);
    await expect.poll(() => sessions.length).toBe(3);
    const reset = Date.now() + 2 * 3_600_000;
    const message = `Codex usage limit reached. Try again at ${new Date(reset).toISOString()}`;
    sessions[2]!.emit({ type: 'error', message });
    expect(await implement).toBe(message);
    await failRun(`implement phase failed: ${message}`);
    expect(store.getRun(runId)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it('anchors a captured relative reset to the limit event through dropActive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const capturedAt = Date.parse('2026-10-27T00:00:00Z');
    vi.setSystemTime(capturedAt);
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    vi.setSystemTime(capturedAt);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await reviewer;
    vi.setSystemTime(capturedAt + 30 * 60_000);
    await failRun(`council failed: ${LIMIT}`);
    expect(store.getRun(runId)?.autoResumeAt)
      .toBe(new Date(capturedAt + 3 * 3_600_000 + AUTO_RESUME_GRACE_MS).toISOString());
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it('does not roll a captured clock reset to tomorrow when the same limit ends the run late', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T23:41:00Z'));
    const reviewer = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    const message = "You've hit your session limit · resets 0:11 (UTC)";
    sessions[1]!.emit({ type: 'error', message });
    await reviewer;
    vi.setSystemTime(new Date('2026-10-27T02:41:00Z'));
    store.updateRun(runId, { status: 'failed', error: `council failed: ${message}` });
    internals.scheduleAutoResumeIfLimited(runId, state.usageLimitedAccount, state.usageLimitedMessage, state.usageLimitedAt);
    expect(store.getRun(runId)?.autoResumeAt).toBe('2026-10-27T00:11:30.000Z');
    expect(manager.accountHolds().deadline.size).toBe(0);
  });

  it('retires a Codex capture proven during a different account resume', async () => {
    store.updateRun(runId, { autoResumeAccount: 'claude:default', autoResumeAttempts: 2 });
    const limited = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await limited;
    const proof = phase('codex', 'proof');
    await expect.poll(() => sessions.length).toBe(3);
    sessions[2]!.emit({ type: 'turn-end' });
    await proof;
    expect(state.usageLimitedMessage).toBeUndefined();
    expect(state.usageLimitedAccount).toBeUndefined();
    expect(store.getRun(runId)).toMatchObject({ autoResumeAccount: 'claude:default', autoResumeAttempts: 2 });
    expect(manager.accountHolds().inFlight).toEqual(new Set(['claude:default']));
    sessions[0]!.emit({ type: 'turn-end' });
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
  });

  it('allows a later turn of an already-running sibling to prove the window', async () => {
    const limited = phase('claude', 'opus');
    await expect.poll(() => sessions.length).toBe(2);
    const sibling = phase('claude', 'sonnet');
    await expect.poll(() => sessions.length).toBe(3);
    rmSync(join(root, 'claude.json'));
    store.updateRun(runId, { autoResumeAttempts: 1, autoResumeAccount: 'claude:default' });
    sessions[1]!.emit({ type: 'error', message: 'Claude usage limit reached. Try again in 3 hours.' });
    await limited;
    sessions[2]!.emit({ type: 'turn-end' });
    expect(store.getRun(runId)?.autoResumeAttempts).toBe(1);
    expect(state.usageLimitedAccount).toBe('claude:default');
    writeFileSync(join(root, 'claude.json'), '{}');
    sessions[2]!.emit({ type: 'turn-end' });
    await sibling;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(state.usageLimitedMessage).toBeUndefined();
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it('guard: the turn already in flight cannot release a same-account resume hold', async () => {
    const limited = phase('claude', 'opus');
    await expect.poll(() => sessions.length).toBe(2);
    const sibling = phase('claude', 'sonnet');
    await expect.poll(() => sessions.length).toBe(3);
    store.updateRun(runId, { autoResumeAttempts: 1, autoResumeAccount: 'claude:default' });
    sessions[1]!.emit({ type: 'error', message: 'Claude usage limit reached. Try again in 3 hours.' });
    await limited;
    sessions[2]!.emit({ type: 'turn-end' });
    await sibling;
    expect(store.getRun(runId)?.autoResumeAttempts).toBe(1);
    expect(manager.accountHolds().inFlight).toEqual(new Set(['claude:default']));
  });

  it('guard: a terminal council limit keeps the first reviewer account and its own reset', async () => {
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    const capturedAt = Date.now();
    const reset = Math.floor((capturedAt + 2 * 3_600_000) / 1000) * 1000;
    const message = `Codex usage limit reached. Try again at ${new Date(reset).toISOString()}`;
    sessions[1]!.emit({ type: 'error', message });
    await reviewer;
    await failRun(`council failed: ${message}`);
    expect(store.getRun(runId)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it('guard: ordinary multiModel-off failures keep run-level scheduling and account keys', async () => {
    store.updateRun(runId, { harness: undefined });
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await reviewer;
    expect(state.usageLimitedAccount).toBeUndefined();
    expect(state.unprovenSessions?.size ?? 0).toBe(0);
    await failRun('tests are red');
    expect(store.getRun(runId)?.autoResumeAt).toBeUndefined();
    store.updateRun(runId, { error: LIMIT });
    internals.scheduleAutoResumeIfLimited(runId, 'codex:default', 'irrelevant capture', 0);
    expect(store.getRun(runId)?.autoResumeAt).toBeDefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline).toEqual(new Set(['claude:default']));
  });

  it.each(['error', 'session.error'])('attributes the reviewer %s stream to its own backend and resolved account', async (type) => {
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    const message = 'OAuth session expired and could not be refreshed';
    sessions[1]!.emit({ type: 'error', message });
    await claude;
    sessions[2]!.emit({ type: 'turn-end' });
    await codex;
    expect(store.readEvents(runId).find((event) => event.type === type && event.message === message))
      .toMatchObject({ backend: 'claude', profileId: 'resolved-work', sessionKey: expect.any(String) });
  });

  it('attributes persisted and live UI events before the reviewer settles', async () => {
    const live = vi.spyOn(store, 'emitEphemeral');
    const reviewer = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    const message = 'OAuth session expired and could not be refreshed';
    sessions[1]!.ui({ type: 'session.error', message, fatal: false });
    sessions[1]!.ui({ type: 'item.updated', item: { id: 'item_1', kind: 'message', role: 'assistant', text: 'a' } });
    sessions[1]!.ui({ type: 'item.updated', item: { id: 'item_1', kind: 'message', role: 'assistant', text: 'ab' } });
    const attribution = { backend: 'claude', profileId: 'resolved-work', sessionKey: expect.any(String) };
    expect(store.readEvents(runId).find((event) => event.type === 'session.error' && event.message === message))
      .toMatchObject(attribution);
    expect(live).toHaveBeenCalledWith(runId, expect.objectContaining(attribution));
    sessions[1]!.emit({ type: 'turn-end' });
    await reviewer;
  });

  it.each([false, true])('guard: sequential phase events still rely on their step attribution (harness=%s)', async (harness) => {
    if (!harness) store.updateRun(runId, { harness: undefined });
    const sequential = phase('codex', 'sequential', false);
    await expect.poll(() => sessions.length).toBe(2);
    const message = 'OAuth session expired and could not be refreshed';
    sessions[1]!.emit({ type: 'error', message });
    await sequential;
    for (const type of ['error', 'session.error']) {
      const event = store.readEvents(runId).find((event) => event.type === type && event.message === message)!;
      expect(event).toBeDefined();
      expect(event).not.toHaveProperty('sessionKey');
      expect(event).not.toHaveProperty('backend');
      expect(event).not.toHaveProperty('profileId');
    }
    expect(store.getRun(runId)?.steps.find((step) => step.id === 'council'))
      .toMatchObject({ backend: 'codex', profileId: 'resolved-work' });
  });

  it('holds the first reviewer account when a different backend spawned last', async () => {
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(3);
    expect(store.getRun(runId)?.steps.find((s) => s.id === 'council')?.backend).toBe('claude');

    sessions[1]!.emit({ type: 'error', message: LIMIT });
    expect(await codex).toBe(LIMIT);
    sessions[2]!.emit({ type: 'turn-end' });
    await claude;
    store.updateStep(runId, 'council', { status: 'failed', error: `quorum failed: ${LIMIT}` });
    store.updateRun(runId, { status: 'failed', error: `quorum failed: ${LIMIT}` });
    internals.scheduleAutoResumeIfLimited(runId, state.usageLimitedAccount);

    expect(store.getRun(runId)?.autoResumeAccount).toBe('codex:default');
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it.each(['codex', 'claude'] as const)('pairs the first %s limit with its own reset when both reviewers fail', async (first) => {
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(3);
    const reset = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    const messages = { codex: `Codex usage limit reached. Try again at ${new Date(reset + 3_600_000).toISOString()}`,
      claude: `Claude AI usage limit reached|${reset / 1000}` };
    const second = first === 'codex' ? 'claude' : 'codex';
    const fail = async (backend: RunnerId) => {
      sessions[backend === 'codex' ? 1 : 2]!.emit({ type: 'error', message: messages[backend as keyof typeof messages] });
      await (backend === 'codex' ? codex : claude);
    };
    await fail(first);
    await fail(second);
    expect.soft(state.usageLimitedAccount).toBe(`${first}:default`);
    expect.soft(state.usageLimitedMessage).toBe(messages[first]);
    store.updateRun(runId, { status: 'failed', error: `${messages.codex}\n${messages.claude}` });
    internals.scheduleAutoResumeIfLimited(runId, state.usageLimitedAccount, state.usageLimitedMessage);
    expect.soft(store.getRun(runId)?.autoResumeAccount).toBe(`${first}:default`);
    expect.soft(store.getRun(runId)?.autoResumeAt)
      .toBe(new Date(reset + (first === 'codex' ? 3_600_000 : 0) + AUTO_RESUME_GRACE_MS).toISOString());
  });

  it('keeps an in-flight account until its proof when another reviewer hits a limit', async () => {
    store.updateRun(runId, { autoResumeAccount: 'claude:default', autoResumeAttempts: 2 });
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    sessions[2]!.emit({ type: 'error', message: LIMIT });
    await codex;
    expect(store.getRun(runId)?.autoResumeAccount).toBe('claude:default');
    expect(manager.accountHolds().inFlight).toEqual(new Set(['claude:default']));
    sessions[1]!.emit({ type: 'turn-end' });
    await claude;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(state.usageLimitedAccount).toBe('codex:default');
    expect(store.getRun(runId)?.autoResumeAccount).toBe('codex:default');
  });

  it('ignores a same-account sibling already running at capture until a fresh session proves the window', async () => {
    const limited = phase('claude', 'opus');
    await expect.poll(() => sessions.length).toBe(2);
    const sibling = phase('claude', 'sonnet');
    await expect.poll(() => sessions.length).toBe(3);
    store.updateRun(runId, { autoResumeAttempts: 1 });
    sessions[1]!.emit({ type: 'error', message: 'Claude usage limit reached. Try again in 3 hours.' });
    await limited;
    sessions[2]!.emit({ type: 'turn-end' });
    await sibling;
    expect(state.usageLimitedAccount).toBe('claude:default');
    expect(store.getRun(runId)?.autoResumeAttempts).toBe(1);
    expect(store.getRun(runId)?.autoResumeAccount).toBe('claude:default');
    const fresh = phase('claude', 'fresh');
    await expect.poll(() => sessions.length).toBe(4);
    sessions[3]!.emit({ type: 'turn-end' });
    await fresh;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(state.usageLimitedMessage).toBeUndefined();
  });

  it('guard: does not retire a limit when another reviewer completes a turn', async () => {
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    store.updateRun(runId, { autoResumeAccount: 'codex:default', autoResumeAttempts: 1 });

    sessions[1]!.emit({ type: 'turn-end' });
    await claude;
    expect(store.getRun(runId)?.autoResumeAttempts).toBe(1);
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));
    sessions[2]!.emit({ type: 'turn-end' });
    await codex;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
  });

  it('guard: schedules an advisor-only limit without attributing an account', () => {
    store.updateStep(runId, 'council', { status: 'failed', backend: 'claude', profileId: 'resolved-work', error: LIMIT });
    store.updateRun(runId, { status: 'failed', error: `advisor failed: ${LIMIT}` });
    internals.scheduleAutoResumeIfLimited(runId);
    expect(store.getRun(runId)?.autoResumeAt).toBeDefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    store.updateRun(runId, { status: 'queued', autoResumeAt: undefined, autoResumeAttempts: 1 });
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each([
    { runner: 'codex' as const, override: undefined, key: 'codex:default' },
    { runner: 'codex' as const, override: 'personal', key: 'codex:personal' },
    { runner: 'claude' as const, override: 'personal', key: 'codex:default' },
  ])('guard: normalizes a phase limit and its proof to the ordinary scheme ($runner/$override)', async ({ runner, override, key }) => {
    store.updateRun(runId, { runner, agentProfile: override });
    const limited = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await limited;
    expect(store.getRun(runId)?.steps.find((step) => step.id === 'council')?.profileId).toBe('resolved-work');
    expect(state.usageLimitedAccount).toBe(key);
    expect(store.getRun(runId)?.autoResumeAccount).toBe(key);
    store.updateRun(runId, { autoResumeAttempts: 1 });
    const proof = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    sessions[2]!.emit({ type: 'turn-end' });
    await proof;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
  });

  it('forgets a prior session limit once that account proves its window before an advisor fails', async () => {
    const limited = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await limited;
    expect(state.usageLimitedAccount).toBe('codex:default');
    const retry = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    sessions[2]!.emit({ type: 'turn-end' });
    await retry;
    expect(state.usageLimitedAccount).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    store.updateRun(runId, { status: 'failed', error: `advisor failed: ${LIMIT}` });
    internals.scheduleAutoResumeIfLimited(runId, state.usageLimitedAccount);
    expect(store.getRun(runId)?.autoResumeAt).toBeDefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
  });

  it('keeps the run current step owned by the non-concurrent session', async () => {
    expect(state.currentStepId).toBe('work');
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    expect(state.currentStepId).toBe('work');
    sessions[1]!.emit({ type: 'turn-end' });
    await reviewer;
    expect(state.currentStepId).toBe('work');
  });

  it('preserves the current step when a concurrent launch fails', async () => {
    expect(await phase('codex', 'throw')).toBe('launch failed');
    expect(state.currentStepId).toBe('work');
  });
});

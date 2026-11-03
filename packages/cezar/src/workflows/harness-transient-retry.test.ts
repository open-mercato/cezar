import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { runHarnessDriver, type HarnessDriverHost } from '../harness/driver.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import * as profiles from '../workspace/agent-profiles.ts';
import { AUTO_RESUME_GRACE_MS, RunManager, runAccountKey } from './run.ts';

type Session = {
  prompt: string;
  emit: (event: AgentEvent) => void;
  end: () => void;
  reject: (message: string) => void;
};
const sessions = vi.hoisted(() => [] as Session[]);
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    startSession: (spec: AgentRunSpec, onEvent: (event: AgentEvent) => void) => {
      let finish: () => void = () => {};
      let fail: (message: string) => void = () => {};
      let open = true;
      const result = new Promise<AgentRunResult>((resolve, reject) => {
        finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
        fail = (message) => { open = false; reject(new Error(message)); };
      });
      sessions.push({ prompt: spec.userPrompt, emit: onEvent, end: finish, reject: fail });
      return { result, get open() { return open; }, sendMessage: () => true, end: finish, interrupt: finish };
    },
  }),
}));
vi.mock('../harness/driver.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/driver.ts')>()),
  runHarnessDriver: vi.fn(async () => null),
}));

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;
const TRANSIENT = 'stream disconnected before completion: upstream closed';
let phaseNumber = 0;

function phase(host: HarnessDriverHost, id: string, runner: 'claude' | 'codex' | 'opencode', concurrent = false) {
  host.upsertStep({ id, name: id, kind: 'agent' });
  const prompt = `${id}-${runner}-${phaseNumber += 1}`;
  const resultPath = join(host.cwd, '.test-results', `${prompt}.json`);
  mkdirSync(join(host.cwd, '.test-results'), { recursive: true });
  const promise = host.runAgent({
    phaseId: id, name: id, skill: undefined, prompt, resultPath, timeoutMs: 20_000,
    env: {}, runner, concurrent, skillSystemPrompt: 'test harness phase',
  });
  return {
    promise, resultPath,
    session: async () => {
      await expect.poll(() => sessions.find((session) => session.prompt === prompt), { timeout: 5_000 }).toBeDefined();
      return sessions.find((session) => session.prompt === prompt)!;
    },
  };
}

async function complete(work: ReturnType<typeof phase>) {
  const session = await work.session();
  writeFileSync(work.resultPath, '{}');
  session.emit({ type: 'turn-end' });
  return work.promise;
}

async function fail(work: ReturnType<typeof phase>, message: string, reject = false) {
  const session = await work.session();
  if (reject) session.reject(message);
  else session.emit({ type: 'error', message });
  return work.promise;
}

describe('harness account capture during a transient retry', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let releases: (() => void)[];
  const internals = () => manager as unknown as {
    autoResumeTimers: Map<string, ReturnType<typeof setTimeout>>;
    fireAutoResume(id: string): void;
  };
  const snapshot = (id: string) => {
    const run = store.getRun(id)!;
    return { attempts: run.autoResumeAttempts, reason: run.autoResumeReason, account: run.autoResumeAccount };
  };
  const settled = async (id: string) => {
    await expect.poll(() => ['failed', 'review', 'done', 'cancelled'].includes(store.getRun(id)?.status ?? '')
      && !manager.isActive(id), { timeout: 10_000 }).toBe(true);
  };
  const fire = (id: string) => {
    clearTimeout(internals().autoResumeTimers.get(id));
    internals().fireAutoResume(id);
  };
  const holdDriver = () => new Promise<void>((resolve) => { releases.push(resolve); });
  const limit = () => {
    const reset = Math.floor((Date.now() + 3 * 3_600_000) / 1000) * 1000;
    return { reset, message: `Codex usage limit reached. Try again at ${new Date(reset).toISOString()}` };
  };
  const failPhase = (runner: 'claude' | 'codex', message: string) => async (host: HarnessDriverHost) =>
    `phase "implement" failed: ${await fail(phase(host, 'implement', runner), message)}`;
  const messages = (id: string) => store.readEvents(id).map((event) => String(event.message ?? ''));

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    sessions.length = 0;
    releases = [];
    root = mkdtempSync(join(tmpdir(), 'cez-harness-transient-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n.test-results/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: root });
    execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({
      multiModel: true, skillsRepos: [], branchNaming: { enabled: false },
    }));
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    vi.mocked(runHarnessDriver).mockReset();
    vi.spyOn(profiles, 'resolveProfileEnvForRoot').mockImplementation(async (_, provider) => ({
      profile: { ...profiles.defaultAgentProfile(provider), id: 'resolved-work' }, env: {},
    }));
  });

  afterEach(async () => {
    for (const release of releases) release();
    for (const run of store.listRuns()) manager.cancel(run.id);
    for (const session of sessions) session.end();
    await expect.poll(() => store.listRuns().some((run) => manager.isActive(run.id))).toBe(false);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([false, true])('T2: a council capture cannot extend a proven transient streak (result rejection=%s)', async (reject) => {
    const { message } = limit();
    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('claude', TRANSIENT));
    const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
    await settled(run.id);
    let afterFix: ReturnType<typeof snapshot> | undefined;
    vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
      const codex = phase(host, 'review', 'codex', true);
      const claude = phase(host, 'review', 'claude', true);
      const opencode = phase(host, 'review', 'opencode', true);
      await Promise.all([codex.session(), claude.session(), opencode.session()]);
      await fail(codex, message, reject);
      await complete(claude);
      await complete(opencode);
      await complete(phase(host, 'fix', 'claude'));
      afterFix = snapshot(run.id);
      return `phase "qualify" failed: ${await fail(phase(host, 'qualify', 'claude'), TRANSIENT)}`;
    });
    fire(run.id);
    await settled(run.id);

    expect(afterFix).toEqual({ attempts: undefined, reason: undefined, account: undefined });
    expect(snapshot(run.id)).toEqual({ attempts: undefined, reason: 'transient', account: undefined });
    expect(messages(run.id).filter((message) => message.startsWith('temporary provider failure')))
      .toEqual([expect.stringContaining('(1/2)'), expect.stringContaining('(1/2)')]);

    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('claude', TRANSIENT));
    fire(run.id);
    await settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ autoResumeAttempts: 1, autoResumeReason: 'transient' });
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(messages(run.id)).toContainEqual(expect.stringMatching(/temporary provider failure — retrying automatically at .*\(2\/2\)$/));
  }, 30_000);

  it('T5: a captured transient retry keeps the Claude admission key', async () => {
    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('claude', TRANSIENT));
    const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
    await settled(run.id);
    const hold = holdDriver();
    let captured = false;
    vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
      await fail(phase(host, 'review', 'codex', true), limit().message);
      await phase(host, 'fix', 'claude').session();
      captured = true;
      await hold;
      return null;
    });
    fire(run.id);
    await expect.poll(() => captured, { timeout: 10_000 }).toBe(true);

    expect(runAccountKey(store.getRun(run.id)!, 'claude')).toBe('claude:default');
    expect(snapshot(run.id)).toEqual({ attempts: 1, reason: 'transient', account: undefined });
  }, 30_000);

  it.each(['capture', 'sequential', 'waiting', 'queued'] as const)(
    'T5: restart at %s admits the Claude retry despite another run\'s Codex deadline', async (checkpoint) => {
      const { message } = limit();
      vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('codex', message));
      const blocker = manager.startRun(workflow, { task: 'Fix issue #643', runner: 'claude' });
      await settled(blocker.id);
      vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('claude', TRANSIENT));
      const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
      await settled(run.id);
      const hold = holdDriver();
      let ready = false;
      vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
        const codex = phase(host, 'review', 'codex', true);
        const claude = phase(host, 'review', 'claude', true);
        await Promise.all([codex.session(), claude.session()]);
        await fail(codex, message);
        if (checkpoint !== 'capture') {
          await complete(claude);
          await phase(host, 'fix', 'claude').session();
        }
        ready = true;
        await hold;
        return null;
      });
      fire(run.id);
      await expect.poll(() => ready, { timeout: 10_000 }).toBe(true);
      if (checkpoint === 'waiting' || checkpoint === 'queued') store.updateRun(run.id, { status: checkpoint });
      let entered = false;
      vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
        entered = true;
        await complete(phase(host, 'fix', 'claude'));
        return null;
      });

      manager.dispose();
      for (const session of sessions) session.end();
      store.flush({ throwOnError: true });
      store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
      manager = new RunManager(store, root);
      await manager.recover();
      await expect.poll(() => entered || store.getRun(run.id)?.queueWaitReason?.kind === 'usage-reset', { timeout: 10_000 }).toBe(true);

      expect(store.getRun(run.id)?.queueWaitReason).toBeUndefined();
      expect(entered).toBe(true);
      await settled(run.id);
      expect(store.getRun(run.id)?.status).toMatch(/^(review|done)$/);
      expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
      expect(store.getRun(blocker.id)?.autoResumeAt).toBeDefined();
    }, 30_000,
  );

  it('guard: usage-limit proof ignores other accounts and reset-less in-flight siblings (P6)', async () => {
    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('codex', limit().message));
    const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
    await settled(run.id);
    const snapshots: ReturnType<typeof snapshot>[] = [];
    const holds: string[][] = [];
    vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
      const limited = phase(host, 'review', 'codex', true);
      const sibling = phase(host, 'review', 'codex', true);
      const other = phase(host, 'review', 'claude', true);
      await Promise.all([limited.session(), sibling.session(), other.session()]);
      await fail(limited, "You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours.");
      for (const work of [other, sibling]) {
        await complete(work);
        snapshots.push(snapshot(run.id));
        holds.push([...manager.accountHolds().inFlight]);
      }
      await complete(phase(host, 'implement', 'codex'));
      return null;
    });
    fire(run.id);
    await settled(run.id);
    expect(snapshots).toEqual([
      { attempts: 1, reason: 'usage_limit', account: 'codex:default' },
      { attempts: 1, reason: 'usage_limit', account: 'codex:default' },
    ]);
    expect(holds).toEqual([['codex:default'], ['codex:default']]);
    expect(snapshot(run.id)).toEqual({ attempts: undefined, reason: undefined, account: undefined });
  }, 30_000);

  it('guard: a usage-limit resume followed by a transient failure shares the counter (T3)', async () => {
    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('codex', limit().message));
    const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
    await settled(run.id);
    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('codex', TRANSIENT));
    fire(run.id);
    await settled(run.id);
    expect(store.getRun(run.id)).toMatchObject({ autoResumeAttempts: 1, autoResumeReason: 'transient' });
    expect(messages(run.id)).toContainEqual(expect.stringMatching(/temporary provider failure — retrying automatically at .*\(2\/2\)$/));
    expect(manager.accountHolds().deadline.size + manager.accountHolds().inFlight.size).toBe(0);
    let retry: ReturnType<typeof snapshot> | undefined;
    vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
      retry = snapshot(run.id);
      await complete(phase(host, 'implement', 'codex'));
      return null;
    });
    fire(run.id);
    await settled(run.id);
    expect(retry).toEqual({ attempts: 2, reason: 'transient', account: undefined });
    expect(snapshot(run.id)).toEqual({ attempts: undefined, reason: undefined, account: undefined });
  }, 30_000);

  it('guard: a degraded capture before a sequential transient failure stays clean (T4)', async () => {
    vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
      const codex = phase(host, 'review', 'codex', true);
      const claude = phase(host, 'review', 'claude', true);
      const opencode = phase(host, 'review', 'opencode', true);
      await Promise.all([codex.session(), claude.session(), opencode.session()]);
      await fail(codex, limit().message);
      await complete(claude);
      await complete(opencode);
      return `phase "fix" failed: ${await fail(phase(host, 'fix', 'claude'), TRANSIENT)}`;
    });
    const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
    await settled(run.id);
    expect(snapshot(run.id)).toEqual({ attempts: undefined, reason: 'transient', account: undefined });
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(manager.accountHolds().deadline.size + manager.accountHolds().inFlight.size).toBe(0);
  }, 30_000);

  it('guard: below-quorum capture during a transient retry schedules the limited account', async () => {
    const { reset, message } = limit();
    vi.mocked(runHarnessDriver).mockImplementationOnce(failPhase('claude', TRANSIENT));
    const run = manager.startRun(workflow, { task: 'Fix issue #642', runner: 'claude' });
    await settled(run.id);
    vi.mocked(runHarnessDriver).mockImplementationOnce(async (host) => {
      const failure = await fail(phase(host, 'review', 'codex', true), message);
      return `review council did not reach quorum: 0 of 2 completed; missing: codex (${failure})`;
    });
    fire(run.id);
    await settled(run.id);
    expect(snapshot(run.id)).toEqual({ attempts: 1, reason: 'usage_limit', account: 'codex:default' });
    expect(store.getRun(run.id)?.autoResumeAt).toBe(new Date(reset + AUTO_RESUME_GRACE_MS).toISOString());
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  }, 30_000);
});

import { buildChildEnv } from '../core/agent-env.ts';
import * as trackerAccess from '../server/tracker/task-access.ts';
import { TrackerAgentBindingError } from '../server/tracker/agent-credentials.ts';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { agentAccountsPath } from '../paths.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';

const trackerAssociation = { kind: 'jira' as const, connectionId: 'c', source: { id: 'cloud', webUrl: 'https://example.atlassian.net' }, externalId: '1', externalName: 'Sam' };

/**
 * Which agent account a STEP spawns under (spec 2026-07-29-agent-profiles).
 *
 * Exercised at the `agentEnvForStep` seam rather than through a real run: the point under test is
 * the resolution order and the exact variable handed to the child, and a full dry-run would prove
 * neither (the mock CLI does not echo its environment).
 */
describe('RunManager agent-profile resolution', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  /** The private seam — same access pattern the auto-naming tests use. */
  type Seam = {
    agentEnvForStep(
      runId: string,
      backend: 'claude' | 'codex' | 'opencode',
      options?: { generateFollowups?: boolean; recordedProfileId?: string },
    ): Promise<{ env: Record<string, string>; trackerContext?: string; profileId: string }>;
  };
  const seam = () => manager as unknown as Seam;

  beforeEach(async () => {
    // A cockpit task's own address must not leak into the zero-config env these tests pin.
    vi.stubEnv('CEZ_API_URL', undefined);
    vi.stubEnv('CEZ_BIN', undefined);
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const addAccount = async (id: string, provider: 'claude' | 'codex', dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push({ id, provider, configDir: dir, label: id, addedAt: '' });
    });
  };

  const selectAccount = async (provider: 'claude' | 'codex', id: string) => {
    await mergeWriteAgentAccounts((store) => {
      const root = realpathSync(repoRoot);
      store.selections[root] = { ...store.selections[root], [provider]: id };
    });
  };

  const newRun = (over: Parameters<RunManager['startRun']>[1] = { task: 't' }) =>
    store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: over.task,
      runner: over.runner,
      agentProfile: over.agentProfile,
      steps: [{ id: 'work', name: 'work', kind: 'agent' }],
    });

  it('delivers fresh context and a scoped capability, never vendor credentials, on steps and continuations', async () => {
    vi.stubEnv('CEZ_API_URL', 'http://127.0.0.1:3456');
    vi.stubEnv('CEZ_BIN', '/synthetic/cezar.js');
    const read = vi.spyOn(trackerAccess, 'trackerTaskContext').mockResolvedValue({ issueId: '100', statusId: 'todo', fetchedAt: new Date().toISOString(), comments: [], transitions: [], limitations: [], item: { kind: 'issue', id: 'SAM-1', title: 'Example', body: 'Current requirements', bodyTruncated: false, unsupportedContent: false, url: 'https://example.com', labels: [], author: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'To Do' } });
    const run = newRun();
    store.updateRun(run.id, { status: 'running', automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', issueId: '100', association: trackerAssociation, access: { version: 1, writes: [] }, url: 'https://example.com' } });
    const first = await seam().agentEnvForStep(run.id, 'claude');
    // The context rides in a file the note points at, never inline in the prompt or argv.
    const contextFile = join(repoRoot, '.ai/cezar/runs', `${run.id}.tracker-context.json`);
    expect(first.trackerContext).toContain(contextFile);
    expect(first.trackerContext).not.toContain('Current requirements');
    expect(JSON.parse(readFileSync(contextFile, 'utf8')).item.body).toBe('Current requirements');
    expect(first.env.JIRA_API_TOKEN).toBeUndefined();
    expect(first.env.LINEAR_API_KEY).toBeUndefined();
    expect(manager.trackerTaskForCapability(first.env.CEZ_TRACKER_CAPABILITY)?.id).toBe(run.id);
    expect(manager.trackerTaskForCapability('forged')).toBeUndefined();
    expect(store.appendEvent(run.id, { type: 'note', message: first.env.CEZ_TRACKER_CAPABILITY! }).message).toBe('[REDACTED]');
    const resumed = await seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'default' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(manager.trackerTaskForCapability(first.env.CEZ_TRACKER_CAPABILITY)).toBeUndefined();
    expect(manager.trackerTaskForCapability(resumed.env.CEZ_TRACKER_CAPABILITY)?.id).toBe(run.id);
    const active = (manager as unknown as { active: Map<string, unknown> }).active;
    active.set(run.id, {});
    const parallelA = await seam().agentEnvForStep(run.id, 'claude');
    const parallelB = await seam().agentEnvForStep(run.id, 'codex');
    expect(manager.trackerTaskForCapability(parallelA.env.CEZ_TRACKER_CAPABILITY)?.id).toBe(run.id);
    expect(manager.trackerTaskForCapability(parallelB.env.CEZ_TRACKER_CAPABILITY)?.id).toBe(run.id);
    active.set(run.id, {});
    expect(manager.trackerTaskForCapability(parallelA.env.CEZ_TRACKER_CAPABILITY)).toBeUndefined();
    active.delete(run.id);
    store.updateRun(run.id, { status: 'done' });
    expect(manager.trackerTaskForCapability(resumed.env.CEZ_TRACKER_CAPABILITY)).toBeUndefined();
  });

  it('preserves a waiting live session grant across another tracker launch', async () => {
    vi.stubEnv('CEZ_API_URL', 'http://127.0.0.1:3456');
    vi.stubEnv('CEZ_BIN', '/synthetic/cezar.js');
    vi.spyOn(trackerAccess, 'trackerTaskContext').mockRejectedValue(new TrackerAgentBindingError('Offline'));
    const active = (manager as unknown as { active: Map<string, unknown> }).active;
    const start = () => {
      const run = newRun();
      store.updateRun(run.id, { status: 'running', automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', issueId: '100', association: trackerAssociation, access: { version: 1, writes: [] }, url: 'https://example.com' } });
      active.set(run.id, { cancelled: false, cwd: repoRoot, currentStepId: 'work', session: { open: true, sendMessage: () => true } });
      return run;
    };
    const first = start();
    const token = (await seam().agentEnvForStep(first.id, 'claude')).env.CEZ_TRACKER_CAPABILITY;
    expect(manager.trackerTaskForCapability(token)?.id).toBe(first.id);
    store.updateRun(first.id, { status: 'waiting' });
    expect(manager.trackerTaskForCapability(token)).toBeUndefined();
    await seam().agentEnvForStep(start().id, 'claude');
    const delivery = manager as unknown as { deliverMessage(id: string, content: { type: 'text'; text: string }[], userAuthored: boolean): boolean };
    expect(delivery.deliverMessage(first.id, [{ type: 'text', text: 'continue' }], false)).toBe(true);
    expect(manager.trackerTaskForCapability(token)?.id).toBe(first.id);
    active.set(first.id, {});
    expect(manager.trackerTaskForCapability(token)).toBeUndefined();
    active.clear();
  });

  it('does not forward or persist an inherited capability in an unbound nested run', async () => {
    const parentGrant = '11111111-1111-4111-8111-11111111111122222222-2222-4222-8222-222222222222';
    vi.stubEnv('CEZ_TRACKER_CAPABILITY', parentGrant);
    const nestedStore = RunStore.open(join(repoRoot, 'nested/.ai/cezar'));
    const nestedManager = new RunManager(nestedStore, repoRoot);
    const run = nestedStore.createRun({ title: 'unbound', workflow: 'quick-task', task: 't', steps: [] });
    const profile = await (nestedManager as unknown as Seam).agentEnvForStep(run.id, 'codex');
    expect(buildChildEnv({ backend: 'codex', extraEnv: profile.env }).CEZ_TRACKER_CAPABILITY).toBeUndefined();
    expect(nestedStore.appendEvent(run.id, { type: 'note', message: parentGrant }).message).toBe('[REDACTED]');
    nestedStore.flush();
  });

  it.each(['normal', 'delete', 'replace'])('fences delayed tracker context on %s', async action => {
    vi.stubEnv('CEZ_API_URL', 'http://127.0.0.1:3456');
    vi.stubEnv('CEZ_BIN', '/synthetic/cezar.js');
    const read = vi.spyOn(trackerAccess, 'trackerTaskContext').mockResolvedValue({ issueId: '100', statusId: 'todo', fetchedAt: new Date().toISOString(), comments: [], transitions: [], limitations: [], item: { kind: 'issue', id: 'SAM-1', title: 'Example', body: 'Current requirements', bodyTruncated: false, unsupportedContent: false, url: 'https://example.com', labels: [], author: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'To Do' } });
    const run = newRun();
    store.updateRun(run.id, { status: 'running', automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', issueId: '100', association: trackerAssociation, access: { version: 1, writes: [] }, url: 'https://example.com' } });

    let release!: (value: Awaited<ReturnType<typeof trackerAccess.trackerTaskContext>>) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const snapshot = await read.getMockImplementation()!('ignored', store.getRun(run.id)!.automationTracker!);
    read.mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const active = (manager as unknown as { active: Map<string, unknown> }).active;
    active.set(run.id, { cancelled: false, interrupt() {} });
    const pending = seam().agentEnvForStep(run.id, 'claude');
    await enteredPromise;
    if (action === 'delete') {
      expect(await manager.cancelAndWait(run.id)).toBe(true);
      expect(store.deleteRun(run.id)).toBe(true);
    }
    if (action === 'replace') active.set(run.id, {});
    release(snapshot);
    const result = await pending;
    if (action !== 'normal') expect(result.env.CEZ_TRACKER_CAPABILITY).toBeUndefined();
    const contextFile = join(repoRoot, '.ai/cezar/runs', `${run.id}.tracker-context.json`);
    if (action !== 'normal') expect(() => readFileSync(contextFile, 'utf8')).toThrow();
    else expect(JSON.parse(readFileSync(contextFile, 'utf8')).item.body).toBe('Current requirements');
  });

  it('starts and continues a legacy or unreadable tracker run with a note instead of failing', async () => {
    vi.stubEnv('CEZ_API_URL', 'http://127.0.0.1:3456');
    vi.stubEnv('CEZ_BIN', '/synthetic/cezar.js');
    const legacy = newRun();
    store.updateRun(legacy.id, { automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', url: 'https://example.com' } });
    for (const options of [{}, { recordedProfileId: 'default' }]) {
      const profile = await seam().agentEnvForStep(legacy.id, 'claude', options);
      expect(profile.env.CEZ_TRACKER_CAPABILITY).toBeUndefined();
      expect(profile.trackerContext).toContain('before mediated tracker access');
      expect(profile.trackerContext).not.toContain('tracker read');
    }
    vi.spyOn(trackerAccess, 'trackerTaskContext').mockRejectedValue(new TrackerAgentBindingError('Tracker offline.'));
    const offline = newRun();
    store.updateRun(offline.id, { status: 'running', automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', issueId: '100', association: trackerAssociation, access: { version: 1, writes: [] }, url: 'https://example.com' } });
    const profile = await seam().agentEnvForStep(offline.id, 'claude', { recordedProfileId: 'default' });
    expect(profile.trackerContext).toContain('Tracker context is unavailable: Tracker offline.');
    // Still able to retry the read once the tracker is back.
    expect(profile.env.CEZ_TRACKER_CAPABILITY).toBeDefined();
  });

  it('does not resolve tracker access for ordinary or dry runs', async () => {
    const read = vi.spyOn(trackerAccess, 'trackerTaskContext');
    const run = newRun();
    expect((await seam().agentEnvForStep(run.id, 'claude')).env.JIRA_API_TOKEN).toBeUndefined();
    vi.stubEnv('CEZ_DRY_RUN', '1');
    store.updateRun(run.id, { automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', url: 'https://example.com' } });
    expect((await seam().agentEnvForStep(run.id, 'claude')).env.CEZ_TRACKER_CAPABILITY).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('redacts turn context before a late title update outlives secret cleanup', async () => {
    const run = newRun();
    const token = 'synthetic-private-value';
    const basic = Buffer.from(`mail@example.com:${token}`).toString('base64');
    store.registerRunSecrets(run.id, [token, basic]);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve });
    const namer = vi.spyOn(manager as unknown as { maybeRefreshTitle(id: string, text: string): Promise<void> }, 'maybeRefreshTitle')
      .mockImplementation(async (id, text) => {
        await pending;
        store.updateRun(id, { titleSummary: text });
      });
    try {
      const recording = manager.recordTurnEnd(run.id, `${token} Basic ${basic}`);
      store.clearRunSecrets(run.id);
      release();
      await recording;
      expect(store.getRun(run.id)?.titleSummary).toBe('[REDACTED] Basic [REDACTED]');
    } finally { release(); namer.mockRestore(); }
  });

  it('adds NOTHING for the default account — the zero-config env is untouched', async () => {
    const run = newRun();
    const { env, profileId } = await seam().agentEnvForStep(run.id, 'claude');
    expect(profileId).toBe('default');
    // The base run env only: the handoff contract (spec 007) plus the task-scoped
    // temp directory (#785). No ACCOUNT variable, which is this test's subject.
    expect(Object.keys(env).sort()).toEqual([
      'CEZ_HANDOFF_FILE',
      'CEZ_TASK_ID',
      'CEZ_TODOS_FILE',
      'TEMP',
      'TMP',
      'TMPDIR',
    ]);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('points the CLI at the project\'s account and reports the id to record', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await selectAccount('claude', 'work');
    const run = newRun();
    const { env, profileId } = await seam().agentEnvForStep(run.id, 'claude');
    expect(profileId).toBe('work');
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-klaudiusz'));
    // The handoff plumbing still rides along — the account is additive, not a replacement.
    expect(env.CEZ_TASK_ID).toBe(run.id);
  });

  it('resolves each step of a MIXED-backend workflow against its own provider', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await addAccount('cx', 'codex', join(home, 'codex-klaudiusz'));
    await selectAccount('claude', 'work');
    await selectAccount('codex', 'cx');
    const run = newRun();

    const claudeStep = await seam().agentEnvForStep(run.id, 'claude');
    const codexStep = await seam().agentEnvForStep(run.id, 'codex');

    expect(claudeStep.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(home, 'claude-klaudiusz') });
    expect(claudeStep.env.CODEX_HOME).toBeUndefined();
    expect(codexStep.env).toMatchObject({ CODEX_HOME: join(home, 'codex-klaudiusz') });
    expect(codexStep.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('lets the composer override the project — but only for the run\'s OWN runner', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await addAccount('client', 'claude', join(home, 'claude-client'));
    await addAccount('cx', 'codex', join(home, 'codex-klaudiusz'));
    await selectAccount('claude', 'work');
    await selectAccount('codex', 'cx');
    const run = newRun({ task: 't', runner: 'claude', agentProfile: 'client' });

    // The run's runner takes the override…
    expect((await seam().agentEnvForStep(run.id, 'claude')).profileId).toBe('client');
    // …a step on a different backend does not: "use my other Claude login" says nothing about
    // which Codex account a mixed workflow should bill.
    expect((await seam().agentEnvForStep(run.id, 'codex')).profileId).toBe('cx');
  });

  it('a RECORDED step profile wins over everything — resume must not follow a changed default', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    const run = newRun();
    // The project has since been switched to the personal account, but the session this
    // continuation resumes lives in the work account's own `sessions/` folder.
    const resolved = await seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'work' });
    expect(resolved.profileId).toBe('work');
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-klaudiusz'));
  });

  it('degrades a deleted account to the default rather than failing the run', async () => {
    await addAccount('work', 'claude', join(home, 'claude-klaudiusz'));
    await selectAccount('claude', 'work');
    await mergeWriteAgentAccounts((store) => {
      store.accounts = [];
    });
    const run = newRun();
    const { env, profileId } = await seam().agentEnvForStep(run.id, 'claude');
    expect(profileId).toBe('default');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('degrades to the default when the accounts file is unreadable', async () => {
    writeFileSync(agentAccountsPath(), '{ not json', 'utf8');
    const run = newRun();
    expect((await seam().agentEnvForStep(run.id, 'claude')).profileId).toBe('default');
  });
});

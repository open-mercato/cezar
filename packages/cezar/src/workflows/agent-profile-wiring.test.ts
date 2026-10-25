import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { agentAccountsPath } from '../paths.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';

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
    ): Promise<{ env: Record<string, string>; profileId: string }>;
  };
  const seam = () => manager as unknown as Seam;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-profile-wiring-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
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

  it('binds tracker credentials and registers literal and Basic values before spawn', async () => {
    const association = { kind: 'jira' as const, source: { id: 'source', webUrl: 'https://example.com' }, externalId: 'SAM', externalName: 'Sam' };
    manager = new RunManager(store, repoRoot, { resolveTrackerEnv: async (_root, expected) => {
      expect(expected).toEqual(association);
      return { JIRA_EMAIL: 'mail@example.com', JIRA_API_TOKEN: 'synthetic-private-value' };
    } });
    const run = newRun();
    store.updateRun(run.id, { automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', url: 'https://example.com', association } });
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    expect(env.JIRA_API_TOKEN).toBe('synthetic-private-value');
    const basic = Buffer.from('mail@example.com:synthetic-private-value').toString('base64');
    expect(store.appendEvent(run.id, { type: 'note', message: `synthetic-private-value Basic ${basic}` }).message).toBe('[REDACTED] Basic [REDACTED]');
  });

  it('does not swallow binding failures on the step and continuation seam', async () => {
    manager = new RunManager(store, repoRoot, { resolveTrackerEnv: async () => { throw new Error('connection changed'); } });
    const run = newRun();
    store.updateRun(run.id, { automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', url: 'https://example.com', association: { kind: 'jira', source: { id: 'source', webUrl: 'https://example.com' }, externalId: 'SAM', externalName: 'Sam' } } });
    await expect(seam().agentEnvForStep(run.id, 'claude')).rejects.toThrow('connection changed');
    await expect(seam().agentEnvForStep(run.id, 'claude', { recordedProfileId: 'default' })).rejects.toThrow('connection changed');
  });

  it('does not resolve tracker credentials for ordinary, legacy, or dry runs', async () => {
    manager = new RunManager(store, repoRoot, { resolveTrackerEnv: async () => { throw new Error('must not resolve'); } });
    const run = newRun();
    expect((await seam().agentEnvForStep(run.id, 'claude')).env.JIRA_API_TOKEN).toBeUndefined();
    store.updateRun(run.id, { automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', url: 'https://example.com' } });
    expect((await seam().agentEnvForStep(run.id, 'claude')).env.JIRA_API_TOKEN).toBeUndefined();
    const previous = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      store.updateRun(run.id, { automationTracker: { ...store.getRun(run.id)!.automationTracker!, association: { kind: 'jira', source: { id: 'source', webUrl: 'https://example.com' }, externalId: 'SAM', externalName: 'Sam' } } });
      expect((await seam().agentEnvForStep(run.id, 'claude')).env.JIRA_API_TOKEN).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = previous;
    }
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

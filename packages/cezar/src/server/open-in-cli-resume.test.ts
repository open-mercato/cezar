import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import type { RunManager } from '../workflows/run.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { apiRequest } from './loopback-request.testkit.ts';

// The terminal launcher actually spawns a process (osascript/cmd/x-terminal-emulator) — mocked
// so this suite exercises only the command construction, never a real terminal window.
vi.mock('./open-in-terminal.js', () => ({ openInTerminal: vi.fn(async () => true) }));

const mockOpenInTerminal = vi.mocked(openInTerminal);

const { createApp } = await import('./server.ts');

const providerAuth = (disconnected: ProviderId[] = []) => new ProviderAuthService({
  platform: 'linux',
  runCommand: async (executable) => {
    const provider = executable === 'claude' ? 'claude' : executable === 'codex' ? 'codex' : 'opencode';
    if (disconnected.includes(provider)) return { stdout: '', stderr: '', exitCode: 1 };
    if (provider === 'claude') return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
    if (provider === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
    return { stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n└  1 credential', stderr: '', exitCode: 0 };
  },
});

const workspaceConfig = (disabledProviders: ProviderId[] = []) => {
  let config: WorkspaceConfig = { ...defaultWorkspaceConfig(), disabledProviders };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => {
      config = mutator(config) ?? config;
      return config;
    },
  };
};

/**
 * `POST /api/v1/runs/:id/open-in` with a `cli:<runner>` target (#402 follow-up): picking the
 * agent CLI that matches the run's own runner resumes THIS run's session — the same
 * `resumeCommand` mapping the client mirrors in run-actions.ts. Every other case (a foreign
 * runner, or no session yet) launches the CLI fresh rather than guessing at a cross-backend
 * resume: a Claude session id means nothing to `codex resume`, so cross-runner picks and
 * sessionless runs both degrade to a plain launch instead of erroring.
 */
describe('POST /api/v1/runs/:id/open-in — agent CLI resume vs fresh launch', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-open-in-cli-'));
    // The account resolution behind the handoff (spec 2026-07-29-agent-profiles) reads
    // `~/.cezar/agent-accounts.json`, so this suite must own one — without `CEZ_HOME` it would read the
    // developer's real workspace and its answers would depend on who ran it.
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-open-in-cli-home-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    mockOpenInTerminal.mockClear();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [repoRoot, home]) rmSync(dir, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const app = (options: { disabled?: ProviderId[]; disconnected?: ProviderId[] } = {}) =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      providerAuth: providerAuth(options.disconnected),
      workspaceConfig: workspaceConfig(options.disabled),
    });

  /** A FINISHED run by default — `createRun` parks new records at `queued`, which the engine still
   *  owns, and only a run the engine has let go of resumes at all (see the status cases below). */
  const makeRun = (runner: 'claude' | 'codex' | 'opencode' | undefined, sessionId?: string) => {
    const run = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      runner,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(run.id, { status: 'done' });
    if (sessionId) store.updateStep(run.id, 'work', { sessionId });
    return run;
  };

  const openIn = (runId: string, target: string, options: { disabled?: ProviderId[]; disconnected?: ProviderId[] } = {}) =>
    apiRequest(app(options), `/api/v1/runs/${runId}/open-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    });

  const openInCli = (runId: string, options: { disabled?: ProviderId[]; disconnected?: ProviderId[] } = {}) =>
    apiRequest(app(options), `/api/v1/runs/${runId}/open-in-cli`, { method: 'POST' });

  it.each([
    ['claude', 'cli:claude', 'claude --resume sess-1'],
    ['codex', 'cli:codex', 'codex resume sess-1'],
    ['opencode', 'cli:opencode', 'opencode --session sess-1'],
  ] as const)('the %s CLI resumes its own %s session', async (runner, target, expected) => {
    const run = makeRun(runner, 'sess-1');
    const res = await openIn(run.id, target);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { command: string }).command).toBe(expected);
    expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), expected, {});
  });

  it('a legacy run with no runner recorded resumes as Claude (pre-runner-choice default)', async () => {
    const run = makeRun(undefined, 'sess-1');
    const res = await openIn(run.id, 'cli:claude');
    expect(((await res.json()) as { command: string }).command).toBe('claude --resume sess-1');
  });

  it("cross-runner: a CLI that is not the run's own launches fresh — no cross-backend resume attempted", async () => {
    const run = makeRun('claude', 'sess-1');
    const res = await openIn(run.id, 'cli:codex');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { command: string }).command).toBe('codex');
    expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), 'codex', {});
  });

  it('no session yet: even the matching CLI launches fresh instead of erroring', async () => {
    const run = makeRun('opencode', undefined);
    const res = await openIn(run.id, 'cli:opencode');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { command: string }).command).toBe('opencode');
  });

  // The run manager seeds `sessionId` when an agent step STARTS, so a live run already carries
  // one. Resuming it here would attach a SECOND CLI process to the transcript the engine is
  // writing — two writers on one session. Active runs degrade to a fresh launch, exactly like a
  // cross-runner pick, which is also what the client's `cliTargetResumes` labels.
  it.each(['running', 'queued', 'waiting'] as const)(
    'a %s run launches fresh — never a second CLI on the session the engine is driving',
    async (status) => {
      const run = makeRun('claude', 'sess-1');
      store.updateRun(run.id, { status });
      const res = await openIn(run.id, 'cli:claude');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { command: string }).command).toBe('claude');
      expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), 'claude', {});
    },
  );

  it.each(['done', 'failed', 'cancelled', 'review'] as const)(
    'a %s run still resumes — the engine has let go of the session',
    async (status) => {
      const run = makeRun('claude', 'sess-1');
      store.updateRun(run.id, { status });
      const res = await openIn(run.id, 'cli:claude');
      expect(((await res.json()) as { command: string }).command).toBe('claude --resume sess-1');
    },
  );

  it('hosted mode (CEZ_REMOTE=1) 409s before any session lookup, CLI or not', async () => {
    process.env.CEZ_REMOTE = '1';
    const run = makeRun('claude', 'sess-1');
    const res = await openIn(run.id, 'cli:claude');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('hosted mode');
    expect(mockOpenInTerminal).not.toHaveBeenCalled();
  });

  it('blocks a disabled CLI target before launching a fresh agent terminal', async () => {
    const run = makeRun('claude');
    const res = await openIn(run.id, 'cli:codex', { disabled: ['codex'] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Codex is disabled. Enable it in Settings → Agents → Providers.',
    });
    expect(mockOpenInTerminal).not.toHaveBeenCalled();
  });

  it('blocks a disabled terminal session handoff before opening the recorded provider', async () => {
    const run = makeRun('codex', 'sess-1');
    const res = await openInCli(run.id, { disabled: ['codex'] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Codex is disabled. Enable it in Settings → Agents → Providers.',
    });
    expect(mockOpenInTerminal).not.toHaveBeenCalled();
  });

  it('blocks a disconnected terminal session handoff before opening the recorded provider', async () => {
    const run = makeRun('codex', 'sess-1');
    const res = await openInCli(run.id, { disconnected: ['codex'] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Codex credentials are unavailable. Authorize it in Settings → Agents → Providers.',
    });
    expect(mockOpenInTerminal).not.toHaveBeenCalled();
  });

  it('blocks a disconnected CLI target before launching a fresh agent terminal', async () => {
    const run = makeRun('claude');
    const res = await openIn(run.id, 'cli:codex', { disconnected: ['codex'] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Codex credentials are unavailable. Authorize it in Settings → Agents → Providers.',
    });
    expect(mockOpenInTerminal).not.toHaveBeenCalled();
  });

  /**
   * The handoff must land on the account that OWNS the session, not on whatever the project is
   * pointed at now. Without the config dir, `claude --resume` finds nothing under the default
   * account and silently opens a fresh conversation — a failure with no error message.
   */
  describe('agent accounts (spec 2026-07-29-agent-profiles)', () => {
    const addAccount = async (id: string, provider: 'claude' | 'codex', dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push({ id, provider, configDir: dir, label: id, addedAt: '' });
      });
    };

    it('resumes under the account recorded on the step', async () => {
      const dir = join(home, 'claude-klaudiusz');
      await addAccount('work', 'claude', dir);
      const run = makeRun('claude', 'sess-1');
      store.updateStep(run.id, 'work', { profileId: 'work' });

      const res = await openIn(run.id, 'cli:claude');

      expect(res.status).toBe(200);
      expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), 'claude --resume sess-1', {
        CLAUDE_CONFIG_DIR: dir,
      });
    });

    it('keeps resuming under the recorded account after the PROJECT switched to another one', async () => {
      const work = join(home, 'claude-klaudiusz');
      await addAccount('work', 'claude', work);
      await addAccount('client', 'claude', join(home, 'claude-client'));
      await mergeWriteAgentAccounts((store) => {
        store.selections[realpathSync(repoRoot)] = { claude: 'client' };
      });
      const run = makeRun('claude', 'sess-1');
      store.updateStep(run.id, 'work', { profileId: 'work' });

      await openIn(run.id, 'cli:claude');

      expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), 'claude --resume sess-1', {
        CLAUDE_CONFIG_DIR: work,
      });
    });

    it('opens a FRESH CLI on the project\'s account, not the machine default', async () => {
      const dir = join(home, 'claude-klaudiusz');
      await addAccount('work', 'claude', dir);
      await mergeWriteAgentAccounts((store) => {
        store.selections[realpathSync(repoRoot)] = { claude: 'work' };
      });
      const run = makeRun('claude'); // no session — the fresh-launch branch

      await openIn(run.id, 'cli:claude');

      expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), 'claude', {
        CLAUDE_CONFIG_DIR: dir,
      });
    });

    it('refuses rather than resuming on the wrong account when the recorded one is gone', async () => {
      const run = makeRun('claude', 'sess-1');
      store.updateStep(run.id, 'work', { profileId: 'deleted-yesterday' });

      const res = await openInCli(run.id);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('no longer exists');
      expect(mockOpenInTerminal).not.toHaveBeenCalled();
    });

    it('adds nothing for a run recorded on the default account', async () => {
      const run = makeRun('claude', 'sess-1');
      store.updateStep(run.id, 'work', { profileId: 'default' });
      await openIn(run.id, 'cli:claude');
      expect(mockOpenInTerminal).toHaveBeenCalledWith(expect.any(String), 'claude --resume sess-1', {});
    });
  });
});

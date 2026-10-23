import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthService,
  type ProviderId,
  type RunProviderCommand,
} from '../core/provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import {
  ProviderRuntimeAuthObserver,
  recoverWithProviderRuntimeAuthObservation,
  watchProviderRuntimeAuthFailures,
} from './provider-auth-runtime.ts';

// `resolveClaudeBin` probes the real machine for an install that is off PATH, so the claude
// executable these cases assert on would otherwise be whatever the DEVELOPER has. Pinned to the
// env-only resolution so the suite reads the same on every host; `claude-bin.test.ts` tests
// discovery for real.
vi.mock('../core/claude-bin.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/claude-bin.ts')>()),
  resolveClaudeBin: () => process.env.CEZ_CLAUDE_BIN ?? 'claude',
}));

// Junie has no read-only auth-status command, so `ProviderAuthService` probes it through a real
// ACP session instead of `runCommand`. Left unmocked, every status probe in this suite spawned a
// real `junie` process (#M3 review). Every test here expects junie 'connected'.
vi.mock('../core/junie-auth-probe.ts', () => ({
  probeJunieAuthentication: vi.fn(async () => ({ connected: true })),
}));

const CONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":true}',
  codex: 'Logged in using ChatGPT',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '●  Anthropic oauth',
    '└  1 credential',
  ].join('\n'),
  cursor: JSON.stringify({
    status: 'authenticated',
    isAuthenticated: true,
    userInfo: { email: 'dev@example.com' },
  }),
  pi: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
  // junie never reaches `runCommand`/`parse` at all — `probe()` special-cases it onto
  // `probeJunieAuthentication` (mocked above), so this value is only here to satisfy
  // `Record<ProviderId, string>` and is never read.
  junie: 'Junie version: 26.9.22 (3419.7)',
  // Copilot's probe drives its ACP server, so its "connected" evidence is the `session/new`
  // answer (`.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`).
  copilot: '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"3f1b6f2e-0000-4000-8000-1f2e3d4c5b6a"}}',
};

const providerForExecutable = (executable: string): ProviderId => {
  if (executable === 'claude' || executable === 'codex' || executable === 'opencode' || executable === 'pi' || executable === 'junie' || executable === 'copilot') return executable;
  if (executable === 'agent') return 'cursor';
  throw new Error(`unexpected executable: ${executable}`);
};

/** A service whose Claude CLI agrees the credentials are gone, so the latch's self-check confirms
 *  the rejection instead of clearing it. */
function loggedOutClaudeProviderAuth(): ProviderAuthService {
  return new ProviderAuthService({
    platform: 'linux',
    runCommand: vi.fn<RunProviderCommand>(async (executable) => (
      executable === 'claude'
        ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
        : { stdout: CONNECTED_OUTPUT[providerForExecutable(executable)], stderr: '', exitCode: 0 }
    )),
    createAuthFailureId: () => 'auth-incident-1',
  });
}

describe('watchProviderRuntimeAuthFailures', () => {
  let root: string;
  let store: RunStore;
  let providerAuth: ProviderAuthService;
  const unwatchers: Array<() => void> = [];
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-provider-auth-runtime-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    delete process.env.CEZ_DRY_RUN;
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    providerAuth = new ProviderAuthService({
      platform: 'linux',
      runCommand,
      createAuthFailureId: () => 'auth-incident-1',
    });
  });

  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const watch = () => {
    const onInvalidated = vi.fn();
    unwatchers.push(watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated));
    return onInvalidated;
  };

  it('invalidates the step backend for an auth error in a mixed-provider run', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'mixed',
      workflow: 'mixed',
      task: 'work',
      runner: 'claude',
      steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
    });
    store.updateStep(run.id, 'implement', { backend: 'codex' });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'implement',
      message: 'authentication failed with HTTP 401',
    });

    expect(onInvalidated).toHaveBeenCalledWith({
      provider: 'codex',
      status: 'disconnected',
      hint: expect.any(String),
      authFailureId: 'auth-incident-1',
    });
    expect(store.readEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'provider-auth-required',
        provider: 'codex',
        authFailureId: 'auth-incident-1',
        stepId: 'implement',
      }),
    ]));
  });

  it('falls back to the run backend when the event has no matching step', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'fallback',
      workflow: 'quick-task',
      task: 'work',
      runner: 'opencode',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'missing',
      message: 'unauthorized credential returned HTTP 401',
    });

    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      status: 'disconnected',
    }));
  });

  it('treats a legacy run with no backend as Claude', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'legacy',
      workflow: 'quick-task',
      task: 'work',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      status: 'disconnected',
    }));
  });

  it.each(['error', 'session.error', 'note'])(
    'observes auth failures carried by %s events',
    (type) => {
      const onInvalidated = watch();
      const run = store.createRun({
        title: type,
        workflow: 'quick-task',
        task: 'work',
        runner: 'codex',
        steps: [],
      });

      store.appendEvent(run.id, {
        type,
        message: 'OAuth access token is invalid',
      });

      expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        status: 'disconnected',
      }));
    },
  );

  it('ignores unrelated errors and non-message events', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'ignore',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'the compiler rejected this TypeScript program',
    });
    store.appendEvent(run.id, {
      type: 'error',
      text: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });
    store.appendEvent(run.id, {
      type: 'tool.result',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it('appends one safe task event when v1 and v2 report the same provider failure', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'duplicate',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });
    store.appendEvent(run.id, {
      type: 'session.error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledTimes(1);
    const required = store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required');
    expect(required).toHaveLength(1);
    const { seq: _seq, ts: _ts, ...safe } = required[0]!;
    expect(safe).toEqual({
      type: 'provider-auth-required',
      provider: 'claude',
      authFailureId: 'auth-incident-1',
    });
  });

  it('records the current incident on each affected task but invalidates the workspace once', () => {
    const onInvalidated = watch();
    const first = store.createRun({
      title: 'first',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    const second = store.createRun({
      title: 'second',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    for (const run of [first, second]) {
      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
    }

    expect(onInvalidated).toHaveBeenCalledTimes(1);
    for (const run of [first, second]) {
      expect(store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required'))
        .toEqual([expect.objectContaining({
          provider: 'claude',
          authFailureId: 'auth-incident-1',
        })]);
    }
  });

  describe('a rejection on a named agent account (telemetry 9e4a95db)', () => {
    const MESSAGE = 'claude: Failed to authenticate: OAuth session expired and could not be refreshed';

    it('latches the account the step ran on, never the default login', async () => {
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');
      const run = store.createRun({
        title: 'work account',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      store.updateStep(run.id, 'work', { backend: 'claude', profileId: 'work' });

      store.appendEvent(run.id, { type: 'error', stepId: 'work', message: MESSAGE });

      // The default login's card is never told it was rejected, and is never self-checked.
      expect(onProviderStatus).not.toHaveBeenCalled();
      expect(verifying).not.toHaveBeenCalled();
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([{ provider: 'claude', status: 'connected' }]),
      });
      expect(providerAuth.peekProfileStatus('claude', 'work')).toMatchObject({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: 'auth-incident-1',
        profileId: 'work',
      });
      expect(store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required'))
        .toEqual([expect.objectContaining({ provider: 'claude', profileId: 'work', stepId: 'work' })]);
    });

    it('falls back to the run override when no step recorded an account', () => {
      const onProviderStatus = watch();
      const run = store.createRun({
        title: 'override',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        agentProfile: 'work',
        steps: [],
      });

      store.appendEvent(run.id, { type: 'error', message: MESSAGE });

      expect(onProviderStatus).not.toHaveBeenCalled();
      expect(providerAuth.peekProfileStatus('claude', 'work')).toMatchObject({ status: 'disconnected' });
    });

    // `claude auth status` answers `loggedIn: true` from the dead token still on disk, so the
    // account's probes (here: every CLI connected) must not lift it until the user rechecks.
    it('keeps a dead login latched through automatic probes until the user rechecks', async () => {
      watch();
      const run = store.createRun({
        title: 'dead refresh token',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      store.updateStep(run.id, 'work', { backend: 'claude', profileId: 'work' });
      store.appendEvent(run.id, { type: 'error', stepId: 'work', message: MESSAGE });

      // The action gate's verify-before-refuse: evict, then probe.
      providerAuth.forgetProfileStatus('claude', 'work');
      await expect(providerAuth.profileStatus('claude', { id: 'work', configDir: '/accounts/work' }))
        .resolves.toMatchObject({ status: 'disconnected', authFailureId: 'auth-incident-1' });

      // The pane's Check again.
      providerAuth.forgetProfileStatus('claude', 'work');
      providerAuth.recheckProfileAuthFailure('claude', 'work');
      await expect(providerAuth.profileStatus('claude', { id: 'work', configDir: '/accounts/work' }))
        .resolves.toEqual({ provider: 'claude', status: 'connected', profileId: 'work' });
    });

    it('still lifts an ordinary rejection on the next connected probe', async () => {
      watch();
      const run = store.createRun({
        title: 'transient',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        agentProfile: 'work',
        steps: [],
      });
      store.appendEvent(run.id, { type: 'error', message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.' });

      await expect(providerAuth.profileStatus('claude', { id: 'work', configDir: '/accounts/work' }))
        .resolves.toMatchObject({ status: 'connected' });
    });

    it('treats an explicit default account as the default login', () => {
      const onProviderStatus = watch();
      const run = store.createRun({
        title: 'default',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      store.updateStep(run.id, 'work', { backend: 'claude', profileId: 'default' });

      store.appendEvent(run.id, { type: 'error', stepId: 'work', message: MESSAGE });

      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', status: 'disconnected' }));
    });
  });

  describe('the latch checks itself against the CLI before it stands', () => {
    const failing = (store_: RunStore, runner: ProviderId = 'claude') => {
      const run = store_.createRun({
        title: 'self-check',
        workflow: 'quick-task',
        task: 'work',
        runner,
        steps: [],
      });
      store_.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      return run;
    };

    it('announces the recovery when the credentials were never gone', async () => {
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      failing(store);
      await verifying.mock.results[0]!.value;

      expect(onProviderStatus.mock.calls.map(([status]) => status)).toEqual([
        expect.objectContaining({ provider: 'claude', status: 'disconnected' }),
        { provider: 'claude', status: 'connected' },
      ]);
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'connected' }),
        ]),
      });
    });

    it('leaves the latch standing when the CLI confirms the logout', async () => {
      providerAuth = loggedOutClaudeProviderAuth();
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      failing(store);
      await verifying.mock.results[0]!.value;

      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: 'auth-incident-1',
      }));
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'disconnected' }),
        ]),
      });
    });

    it('does not self-check away a login the vendor called dead (telemetry 9e4a95db)', async () => {
      // Every CLI answers connected — exactly what `claude auth status` says with a dead refresh token.
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');
      const run = store.createRun({ title: 'dead', workflow: 'quick-task', task: 'work', runner: 'claude', steps: [] });

      store.appendEvent(run.id, {
        type: 'error',
        message: 'claude: Failed to authenticate: OAuth session expired and could not be refreshed',
      });
      await verifying.mock.results[0]!.value;
      // A later ordinary auth line under the same incident does not soften it.
      store.appendEvent(run.id, { type: 'note', message: 'unauthorized: 401 token expired' });

      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      await expect(providerAuth.status({ refresh: true })).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'disconnected', authFailureId: 'auth-incident-1' }),
        ]),
      });
      await expect(providerAuth.verifyRuntimeAuthFailure('claude')).resolves.toBeNull();

      // Settings' Try again is the user's word that they signed in again.
      expect(providerAuth.clearRuntimeAuthFailure('claude', 'auth-incident-1')).toBe(true);
      await expect(providerAuth.status({ refresh: true })).resolves.toMatchObject({
        providers: expect.arrayContaining([{ provider: 'claude', status: 'connected' }]),
      });
    });

    it('self-checks once for a burst of auth-shaped lines under one latch', async () => {
      watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');
      const run = failing(store);

      // Same run, same incident: the second and third line describe the latch already standing.
      for (const type of ['session.error', 'note']) {
        store.appendEvent(run.id, { type, message: 'unauthorized: 401 token expired' });
      }
      await verifying.mock.results[0]!.value;

      expect(verifying).toHaveBeenCalledTimes(1);
    });

    it('keeps the task transcript record of what the runner reported', async () => {
      watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');
      const run = failing(store);
      await verifying.mock.results[0]!.value;

      // Recovery repairs workspace status, not history: the task still shows why it stopped.
      expect(store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required'))
        .toEqual([expect.objectContaining({ provider: 'claude', authFailureId: 'auth-incident-1' })]);
    });
  });

  it('unsubscribes cleanly', () => {
    const onInvalidated = vi.fn();
    const unwatch = watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated);
    const run = store.createRun({
      title: 'unsubscribed',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    unwatch();
    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it('deduplicates observation when startup and app construction watch the same store', () => {
    const onInvalidated = vi.fn();
    const observer = new ProviderRuntimeAuthObserver(providerAuth, onInvalidated);
    const run = store.createRun({
      title: 'deduplicated',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    observer.watch(store);
    observer.watch(store);
    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it('attaches boot-store observation before recovery can emit an auth failure', async () => {
    const run = store.createRun({
      title: 'boot recovery',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    // A CLI that agrees the credentials are gone, so the self-check leaves the latch standing and
    // this case stays about its own subject: observation is attached BEFORE recovery runs.
    providerAuth = loggedOutClaudeProviderAuth();
    const observer = new ProviderRuntimeAuthObserver(providerAuth, vi.fn());

    await recoverWithProviderRuntimeAuthObservation(
      store,
      async () => {
        store.appendEvent(run.id, {
          type: 'error',
          message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
        });
      },
      observer,
    );

    await expect(providerAuth.status().then(({ providers }) => providers[0]))
      .resolves.toMatchObject({ provider: 'claude', status: 'disconnected' });
  });
});

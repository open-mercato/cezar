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

const CONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":true}',
  codex: 'Logged in using ChatGPT',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '●  Anthropic oauth',
    '└  1 credential',
  ].join('\n'),
  pi: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
};

const providerForExecutable = (executable: string): ProviderId => {
  if (executable === 'claude' || executable === 'codex' || executable === 'opencode' || executable === 'pi') return executable;
  throw new Error(`unexpected executable: ${executable}`);
};

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

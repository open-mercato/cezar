import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginSessionSchema } from '@open-mercato/cezar-contract';
import { onAccountReconnected } from './account-reconnected.ts';
import { ProviderAuthService } from './provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';

vi.mock('./claude-bin.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-bin.ts')>()),
  resolveClaudeBin: () => 'claude',
}));
vi.mock('./junie-auth-probe.ts', () => ({ probeJunieAuthentication: vi.fn(async () => ({ connected: true })) }));

const SAVED = ['CEZ_DRY_RUN', 'CEZ_REMOTE', 'CEZ_REMOTE_AGENT_ACCOUNTS'].map((name) => [name, process.env[name]] as const);

describe('login-session routes (spec 2026-11-18-inline-account-reconnect)', () => {
  let root: string;
  let store: RunStore;
  let events: Array<{ event: string; data: unknown }>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-login-routes-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_REMOTE_AGENT_ACCOUNTS;
    events = [];
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of SAVED) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const app = (options: { bindHost?: string; providerAuth?: ProviderAuthService } = {}) => {
    const workspaceEvents = new WorkspaceEventBus();
    workspaceEvents.on((event, data) => events.push({ event, data }));
    return createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      providerAuth: options.providerAuth ?? new ProviderAuthService({ platform: 'linux', runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }) }),
      bindHost: options.bindHost,
      workspaceEvents,
      loginWatchOffsetsMs: [],
    });
  };
  const post = (server: ReturnType<typeof app>, path: string, body: unknown) => apiRequest(server, `/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('starts a mock session locally under CEZ_DRY_RUN and emits agent-login', async () => {
    const response = await post(app(), '/providers/login', { provider: 'claude' });
    expect(response.status).toBe(200);
    const session = loginSessionSchema.parse(await response.json());
    expect(session).toMatchObject({ provider: 'claude', profileId: 'default', method: 'device', userCode: 'DRYR-UN00' });
    expect(events.some((e) => e.event === 'agent-login')).toBe(true);
  });

  it('refuses hosted web without CEZ_REMOTE_AGENT_ACCOUNTS like Connect does', async () => {
    const server = app({ bindHost: '0.0.0.0' });
    const response = await post(server, '/providers/login', { provider: 'claude' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Run this command on the machine hosting cezar.', command: "'claude' auth login" });
    const named = await post(server, '/providers/login', { provider: 'claude', profileId: 'work' });
    expect(named.status).toBe(409);
    expect(await named.json()).not.toHaveProperty('command');
  });

  it('lets hosted web start a sign-in once the operator opted in', async () => {
    process.env.CEZ_REMOTE_AGENT_ACCOUNTS = '1';
    const response = await post(app({ bindHost: '0.0.0.0' }), '/providers/login', { provider: 'codex' });
    expect(response.status).toBe(200);
  });

  it('accepts API keys for Codex and OpenCode only', async () => {
    const server = app();
    expect((await post(server, '/providers/login', { provider: 'claude', method: 'key' })).status).toBe(400);
    const started = loginSessionSchema.parse(await (await post(server, '/providers/login', { provider: 'codex', method: 'key' })).json());
    expect(started).toMatchObject({ method: 'key', phase: 'needs-input' });
    const answered = await post(server, `/providers/login/${started.sessionId}/input`, { apiKey: 'sk-route-secret' });
    expect(answered.status).toBe(200);
    expect(await answered.text()).not.toContain('sk-route-secret');
    expect(JSON.stringify(events)).not.toContain('sk-route-secret');
  });

  it('validates input and answers 404 for an unknown session', async () => {
    const server = app();
    expect((await post(server, '/providers/login/nope/input', { code: 'x' })).status).toBe(404);
    expect((await post(server, '/providers/login/nope/input', { code: 'x', extra: 1 })).status).toBe(400);
    expect((await post(server, '/providers/login', { provider: 'claude', method: 'magic' })).status).toBe(400);
  });

  it('cancels a session', async () => {
    const server = app();
    const started = loginSessionSchema.parse(await (await post(server, '/providers/login', { provider: 'cursor' })).json());
    const response = await apiRequest(server, `/api/v1/providers/login/${started.sessionId}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(loginSessionSchema.parse(await response.json()).phase).toBe('cancelled');
  });

  it('resumes what was parked when Try again clears the incident', async () => {
    delete process.env.CEZ_DRY_RUN;
    const providerAuth = new ProviderAuthService({
      platform: 'linux',
      createAuthFailureId: () => 'incident-1',
      runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }),
    });
    providerAuth.reportRuntimeAuthFailure('claude');
    const seen: string[] = [];
    const off = onAccountReconnected((event) => {
      seen.push(`${event.provider}:${event.profileId}`);
      return { runs: [], managers: [] };
    });
    try {
      const response = await post(app({ providerAuth }), '/providers/claude/retry', { authFailureId: 'incident-1' });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(seen).toEqual(['claude:default']));
      expect(events.some((e) => e.event === 'account-reconnected')).toBe(true);
    } finally {
      off();
    }
  });
});

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfileResponse, AgentProfilesResponse } from '@open-mercato/cezar-contract';
import { agentHomesDir } from '../paths.ts';
import { runInRelayScope } from '../relay/scope.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

vi.mock('../core/claude-bin.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/claude-bin.ts')>()),
  resolveClaudeBin: () => process.env.CEZ_CLAUDE_BIN ?? 'claude',
}));
vi.mock('../core/junie-auth-probe.ts', () => ({
  probeJunieAuthentication: vi.fn(async () => ({ connected: true })),
}));

/** Accounts added from the cockpit, and the phone's path-free view (spec 2026-11-24-add-account-in-cockpit). */
describe('managed agent accounts API', () => {
  const keys = ['CEZ_HOME', 'CEZ_REMOTE', 'CEZ_REMOTE_AGENT_ACCOUNTS', 'CEZ_BROWSE_ROOT', 'CEZ_DRY_RUN'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-managed-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-managed-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_BROWSE_ROOT = home;
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_REMOTE_AGENT_ACCOUNTS;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await apiRequest(app(), path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as AgentProfileResponse & { error?: string } };
  };
  const phone = <T>(fn: () => Promise<T>) => runInRelayScope({ deviceId: 'phone' }, fn);
  const PATH = '/api/v1/workspace/agent-profiles';

  it('creates a pending account in a private folder cezar owns', async () => {
    const res = await send('POST', PATH, { provider: 'claude', label: 'Work', managed: true });
    expect(res.status).toBe(201);
    expect(res.body.profile).toMatchObject({ id: 'work', provider: 'claude', label: 'Work', managed: true, pending: true });
    const dir = join(agentHomesDir(), 'claude', 'work');
    expect(res.body.profile.path).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    const [stored] = (await loadAgentAccounts()).accounts;
    expect(stored).toMatchObject({ id: 'work', configDir: dir, managed: true, pending: true });

    // A second "Work" gets its own id and folder.
    const again = await send('POST', PATH, { provider: 'claude', label: 'Work', managed: true });
    expect(again.body.profile.id).not.toBe('work');
    expect(again.body.profile.path).toBe(join(agentHomesDir(), 'claude', again.body.profile.id));
  });

  it('takes exactly one of configDir and managed', async () => {
    expect((await send('POST', PATH, { provider: 'claude', managed: true, configDir: join(home, 'x') })).status).toBe(400);
    expect((await send('POST', PATH, { provider: 'claude' })).status).toBe(400);
    expect((await send('POST', PATH, { provider: 'opencode', managed: true })).status).toBe(400);
  });

  it('refuses a managed account on a hosted cockpit without the opt-in', async () => {
    process.env.CEZ_REMOTE = '1';
    expect((await send('POST', PATH, { provider: 'claude', managed: true })).status).toBe(409);
  });

  it('removing a managed account deletes its folder; an unmanaged folder stays', async () => {
    const made = await send('POST', PATH, { provider: 'codex', label: 'Acme', managed: true });
    const own = join(home, 'own-codex');
    mkdirSync(own);
    const pointed = await send('POST', PATH, { provider: 'codex', label: 'Own', configDir: own });
    expect(pointed.status).toBe(201);

    expect((await send('DELETE', `${PATH}/${made.body.profile.id}`)).status).toBe(200);
    expect(existsSync(made.body.profile.path)).toBe(false);
    expect((await send('DELETE', `${PATH}/${pointed.body.profile.id}`)).status).toBe(200);
    expect(existsSync(own)).toBe(true);
  });

  describe('from a paired phone', () => {
    it('lists accounts without any host path', async () => {
      await send('POST', PATH, { provider: 'claude', label: 'Work', managed: true });
      const body = await phone(async () => (await apiRequest(app(), PATH)).json()) as AgentProfilesResponse;
      expect(body.editable).toBe(true);
      expect(body.hostPaths).toBe(false);
      expect(body.selections).toEqual({});
      expect(body.profiles.length).toBeGreaterThan(1);
      for (const profile of body.profiles) {
        expect(profile.configDir).toBe('');
        expect(profile.path).toBe('');
        expect(profile.files).toEqual([]);
      }
      expect(JSON.stringify(body)).not.toContain(home);
      expect(body.profiles.find((p) => p.id === 'work')).toMatchObject({ managed: true, pending: true });
    });

    it('adds a managed account, never one at a client path', async () => {
      const made = await phone(() => send('POST', PATH, { provider: 'claude', label: 'Work', managed: true }));
      expect(made.status).toBe(201);
      expect(made.body.profile).toMatchObject({ id: 'work', configDir: '', path: '', managed: true });
      expect(existsSync(join(agentHomesDir(), 'claude', 'work'))).toBe(true);

      const pointed = await phone(() => send('POST', PATH, { provider: 'claude', configDir: join(home, 'x') }));
      expect(pointed.status).toBe(409);
    });

    it('removes only managed accounts', async () => {
      const own = join(home, 'own-claude');
      mkdirSync(own);
      const pointed = await send('POST', PATH, { provider: 'claude', label: 'Own', configDir: own });
      const made = await send('POST', PATH, { provider: 'claude', label: 'Work', managed: true });

      expect((await phone(() => send('DELETE', `${PATH}/${pointed.body.profile.id}`))).status).toBe(409);
      expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toContain(pointed.body.profile.id);
      expect((await phone(() => send('DELETE', `${PATH}/${made.body.profile.id}`))).status).toBe(200);
      expect(existsSync(made.body.profile.path)).toBe(false);
    });

    it('does not trust a hand-edited managed flag on a folder outside agent-homes', async () => {
      const own = join(home, 'own-claude');
      mkdirSync(own);
      const pointed = await send('POST', PATH, { provider: 'claude', label: 'Own', configDir: own });
      await mergeWriteAgentAccounts((s) => {
        const row = s.accounts.find((a) => a.id === pointed.body.profile.id);
        if (row) row.managed = true;
      });

      expect((await phone(() => send('DELETE', `${PATH}/${pointed.body.profile.id}`))).status).toBe(409);
      expect((await loadAgentAccounts()).accounts.map((a) => a.id)).toContain(pointed.body.profile.id);
      expect(existsSync(own)).toBe(true);
    });

    it('still may not edit an account', async () => {
      const made = await send('POST', PATH, { provider: 'claude', label: 'Work', managed: true });
      expect((await phone(() => send('PATCH', `${PATH}/${made.body.profile.id}`, { label: 'X' }))).status).toBe(409);
    });
  });
});

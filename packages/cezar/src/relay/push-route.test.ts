import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { identityFromRoot, type RelayIdentityStore } from './identity.ts';
import { runInRelayScope } from './scope.ts';
import { RelayService } from './service.ts';
import { b64u } from './wire.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

const ORIGIN = 'https://relay.example.test';
const SAVED = ['CEZ_HOME', 'CEZ_RELAY_URL', 'CEZ_RELAY', 'CEZ_PUSH', 'CEZ_REMOTE'] as const;
const DEVICE = 'dXtIS8djB99atVWpeg3BQw';
const OTHER = 'AAAAAAAAAAAAAAAAAAAAAA';
const KEY43 = 'A'.repeat(43);
const GRANT = { grant: 'sealed-grant', grantId: 'BBBBBBBBBBBBBBBBBBBBBB', expiresAt: 1_801_267_200 };
const JSON_HEADERS = { 'content-type': 'application/json' };
const identity = identityFromRoot(Buffer.alloc(32, 7));

describe('/workspace/phone/push (spec R5)', () => {
  const saved = new Map<string, string | undefined>();
  let home: string;
  let repoRoot: string;
  let relayDir: string;
  let store: RunStore;
  let relay: RelayService;

  beforeEach(() => {
    for (const key of SAVED) saved.set(key, process.env[key]);
    for (const key of SAVED) delete process.env[key];
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-push-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-push-repo-'));
    relayDir = join(home, 'relay');
    mkdirSync(relayDir, { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_RELAY_URL = ORIGIN;
    writeFileSync(join(relayDir, 'devices.json'), JSON.stringify({
      devices: [DEVICE, OTHER].map((deviceId) => ({ deviceId, label: 'Phone', platform: 'android', relayKey: KEY43, noiseKey: KEY43, addedAt: '', grants: [] })),
    }));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    relay = new RelayService({ directory: relayDir, env: process.env, identity: { load: async () => identity, ensure: async () => identity } as unknown as RelayIdentityStore });
  });

  afterEach(() => {
    relay.dispose();
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const key of SAVED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', relay });
  const asPhone = (app: ReturnType<typeof makeApp>, init?: RequestInit, deviceId = DEVICE): Promise<Response> =>
    Promise.resolve(runInRelayScope({ deviceId }, () => app.request('/api/v1/workspace/phone/push', init)));
  const putGrant = (body: unknown = GRANT): RequestInit => ({ method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const rows = () => (JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8')) as { devices: Array<{ deviceId: string; grants: string[]; push?: unknown }> }).devices;

  it('refuses every method outside a relay scope, so the desktop cannot hand a grant for a phone', async () => {
    const app = makeApp();
    for (const init of [undefined, putGrant(), { method: 'DELETE' }]) {
      const response = await app.request('/api/v1/workspace/phone/push', { ...init, headers: { ...JSON_HEADERS, host: '127.0.0.1' } });
      expect(response.status).toBe(403);
    }
    expect(rows().every((row) => row.push === undefined)).toBe(true);
  });

  it('gives the phone the Ed25519 key a grant must name', async () => {
    const response = await asPhone(makeApp());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true, cezarKey: b64u(identity.edPublic) });
  });

  it('stores the grant on the calling device only, and Remove would deny it', async () => {
    const app = makeApp();
    const response = await asPhone(app, putGrant());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ grantId: GRANT.grantId, grantExpiresAt: GRANT.expiresAt });
    const [mine, other] = rows();
    expect(mine).toMatchObject({ push: GRANT, grants: [GRANT.grantId] });
    expect(other?.push).toBeUndefined();
    const list = await (await app.request('/api/v1/workspace/phones', { headers: { host: '127.0.0.1' } })).json() as { phones: Array<{ deviceId: string; push?: boolean }> };
    expect(list.phones.find((phone) => phone.deviceId === DEVICE)?.push).toBe(true);
    expect(list.phones.find((phone) => phone.deviceId === OTHER)).not.toHaveProperty('push');
    expect(relay.remove(DEVICE)).toBe(true);
    const removal = (JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8')) as { pendingRemovals: Array<{ grants: string[] }> }).pendingRemovals;
    expect(removal[0]?.grants).toEqual([GRANT.grantId]);
  });

  it('keeps an old grant id after a renewal, so Remove still denies it', async () => {
    const app = makeApp();
    await asPhone(app, putGrant());
    await asPhone(app, putGrant({ ...GRANT, grant: 'renewed', grantId: 'CCCCCCCCCCCCCCCCCCCCCC' }));
    expect(rows()[0]).toMatchObject({ grants: [GRANT.grantId, 'CCCCCCCCCCCCCCCCCCCCCC'], push: { grant: 'renewed' } });
  });

  it('refuses a body with any other key', async () => {
    const response = await asPhone(makeApp(), putGrant({ ...GRANT, token: 'fcm-token' }));
    expect(response.status).toBe(400);
    expect(rows()[0]?.push).toBeUndefined();
  });

  it('DELETE clears only the grant, and the id stays listed for Remove', async () => {
    const app = makeApp();
    await asPhone(app, putGrant());
    const response = await asPhone(app, { method: 'DELETE' });
    expect(await response.json()).toEqual({ ok: true });
    expect(rows()[0]).toMatchObject({ grants: [GRANT.grantId] });
    expect(rows()[0]?.push).toBeUndefined();
  });

  it('CEZ_PUSH=0 reports push unavailable and takes no grant', async () => {
    process.env.CEZ_PUSH = '0';
    const app = makeApp();
    expect(await (await asPhone(app)).json()).toEqual({ available: false });
    expect((await asPhone(app, putGrant())).status).toBe(409);
    expect(rows()[0]?.push).toBeUndefined();
  });

  it('answers 404 for a scope whose device has no row', async () => {
    const response = await asPhone(makeApp(), undefined, 'ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(response.status).toBe(404);
  });

  it('names the manager of the latest push for the tap, and drops it once the manager is gone', async () => {
    const app = makeApp();
    await asPhone(app, putGrant());
    relay.signalPush('no-such-manager');
    const state = await (await asPhone(app)).json() as Record<string, unknown>;
    expect(state).not.toHaveProperty('managerId');
  });
});

describe('/workspace/phone/signals (spec R5, stage 1)', () => {
  const saved = new Map<string, string | undefined>();
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let relay: RelayService;

  beforeEach(() => {
    for (const key of SAVED) saved.set(key, process.env[key]);
    for (const key of SAVED) delete process.env[key];
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-signal-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-signal-repo-'));
    const relayDir = join(home, 'relay');
    mkdirSync(relayDir, { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_RELAY_URL = ORIGIN;
    writeFileSync(join(relayDir, 'devices.json'), JSON.stringify({
      devices: [{ deviceId: DEVICE, label: 'Phone', platform: 'android', relayKey: KEY43, noiseKey: KEY43, addedAt: '', grants: [] }],
    }));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    relay = new RelayService({ directory: relayDir, env: process.env, identity: { load: async () => identity, ensure: async () => identity } as unknown as RelayIdentityStore });
  });

  afterEach(() => {
    relay.dispose();
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const key of SAVED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', relay });
  const open = (app: ReturnType<typeof makeApp>, deviceId = DEVICE, signal?: AbortSignal): Promise<Response> =>
    Promise.resolve(runInRelayScope({ deviceId }, () => app.request('/api/v1/workspace/phone/signals', signal ? { signal } : undefined)));

  it('refuses outside a relay scope, and for a device with no row', async () => {
    const app = makeApp();
    expect((await app.request('/api/v1/workspace/phone/signals', { headers: { host: '127.0.0.1' } })).status).toBe(403);
    expect((await open(app, 'ZZZZZZZZZZZZZZZZZZZZZZ')).status).toBe(404);
  });

  it('says ready, carries a delivered signal, and unregisters on abort', async () => {
    const app = makeApp();
    const aborter = new AbortController();
    const response = await open(app, DEVICE, aborter.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil('event: ready');
    const opened = relay as unknown as { signalStreams: Map<string, Set<(managerId: string | undefined) => void>> };
    const streams = opened.signalStreams.get(DEVICE);
    expect(streams?.size).toBe(1);
    for (const send of streams!) send('manager-1');
    await readUntil('event: signal');
    await readUntil('}');
    expect(text).toContain('data: {"managerId":"manager-1"}');
    aborter.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(opened.signalStreams.has(DEVICE)).toBe(false));
  });

  it('opens nothing under CEZ_PUSH=0', async () => {
    process.env.CEZ_PUSH = '0';
    expect((await open(makeApp())).status).toBe(409);
  });
});

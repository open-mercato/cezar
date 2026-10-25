import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { hashPassword, parseBasicAuth, safeEqualString, verifyPassword } from './auth-crypto.ts';
import { loadOrCreateCert } from './certs.ts';
import { LanAccess, type LanAccessDeps } from './lan-access.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { startServer } from './server.ts';

/** Spec 2026-10-20-lan-basic-auth-https. The loopback side must behave exactly as before; the LAN
 *  side must refuse everything that is not our own Host plus valid credentials. */

function memoryConfig(initial: WorkspaceConfig = defaultWorkspaceConfig()) {
  let current = initial;
  return {
    get current() { return current; },
    load: async () => structuredClone(current),
    mergeWrite: async (mutator: (config: WorkspaceConfig) => WorkspaceConfig | void) => {
      const next = structuredClone(current);
      current = mutator(next) ?? next;
      return structuredClone(current);
    },
  };
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('LanAccess (unit)', () => {
  let clock = 0;
  let config: ReturnType<typeof memoryConfig>;
  let available = true;
  const lan = () => new LanAccess({
    // A trivially fast "hash" keeps these cases about policy, not scrypt.
    hashPassword: async (password) => ({ salt: '00', hash: Buffer.from(password).toString('hex') }),
    verifyPassword: async (password, stored) => Buffer.from(password).toString('hex') === stored.hash,
    parseBasicAuth,
    safeEqualString,
    loadOrCreateCert: () => { throw new Error('no certificates in unit tests'); },
    available: () => available,
    config,
    addresses: () => [],
    now: () => clock,
  } satisfies LanAccessDeps);

  beforeEach(() => {
    clock = 0;
    available = true;
    config = memoryConfig();
  });

  it('refuses to turn on without credentials and never stores the password itself', async () => {
    const access = lan();
    expect(await access.apply({ lanAccess: true })).toEqual({ ok: false, status: 400, error: expect.stringContaining('required') });
    expect(await access.apply({ lanAccess: true, username: 'alex' })).toMatchObject({ ok: false, status: 400 });
    expect(await access.apply({ lanAccess: false, username: 'alex', password: 'correct horse' })).toEqual({ ok: true });
    expect(JSON.stringify(config.current.security)).not.toContain('correct horse');
    expect(config.current.security).toMatchObject({ lanAccess: false, auth: { username: 'alex' } });
    // Stored credentials now satisfy a later switch-on with no password in the request.
    expect(await access.apply({ lanAccess: true })).toEqual({ ok: true });
    expect(config.current.security?.lanAccess).toBe(true);
  });

  it('is refused outright on a hosted cockpit or when disabled by CEZ_LAN_ACCESS=0', async () => {
    available = false;
    expect(await lan().apply({ lanAccess: true, username: 'a', password: '12345678' })).toMatchObject({ ok: false, status: 409 });
    expect(config.current.security).toBeUndefined();
    expect((await lan().status(true)).available).toBe(false);
    expect((await lan().status(true)).editable).toBe(false);
  });

  it('challenges, accepts, caches, and forgets the cache when the password changes', async () => {
    const access = lan();
    await access.apply({ lanAccess: false, username: 'alex', password: 'first-pass' });
    expect(await access.authorize(undefined, '10.0.0.9')).toBe('challenge');
    expect(await access.authorize(basic('alex', 'nope-nope'), '10.0.0.9')).toBe('challenge');
    expect(await access.authorize(basic('bob', 'first-pass'), '10.0.0.9')).toBe('challenge');
    expect(access.isVerified(basic('alex', 'first-pass'))).toBe(false);
    expect(await access.authorize(basic('alex', 'first-pass'), '10.0.0.9')).toBe('ok');
    expect(access.isVerified(basic('alex', 'first-pass'))).toBe(true);

    await access.apply({ lanAccess: false, username: 'alex', password: 'second-pass' });
    expect(access.isVerified(basic('alex', 'first-pass'))).toBe(false);
    expect(await access.authorize(basic('alex', 'first-pass'), '10.0.0.9')).toBe('challenge');
    expect(await access.authorize(basic('alex', 'second-pass'), '10.0.0.9')).toBe('ok');
  });

  it('pays for scrypt on a wrong username too, so timing does not reveal valid usernames', async () => {
    let verifications = 0;
    const access = new LanAccess({
      hashPassword: async (password) => ({ salt: '00', hash: Buffer.from(password).toString('hex') }),
      verifyPassword: async () => { verifications += 1; return false; },
      parseBasicAuth, safeEqualString,
      loadOrCreateCert: () => { throw new Error('unused'); },
      available: () => true, config, addresses: () => [], now: () => clock,
    });
    expect(await access.authorize(basic('nobody', 'whatever-1'), '10.0.0.9')).toBe('challenge'); // nothing configured yet
    await access.apply({ lanAccess: false, username: 'alex', password: 'the-password' });
    expect(await access.authorize(basic('nobody', 'whatever-2'), '10.0.0.9')).toBe('challenge');
    expect(verifications).toBe(2);
  });

  it('throttles one address after repeated failures, not its neighbours, and lets it retry later', async () => {
    const access = lan();
    await access.apply({ lanAccess: false, username: 'alex', password: 'the-password' });
    for (let i = 0; i < 9; i++) expect(await access.authorize(basic('alex', `wrong-${i}`), '10.0.0.9')).toBe('challenge');
    expect(await access.authorize(basic('alex', 'wrong-last'), '10.0.0.9')).toBe('throttled');
    // Even the right password waits out the window.
    expect(await access.authorize(basic('alex', 'the-password'), '10.0.0.9')).toBe('throttled');
    expect(await access.authorize(basic('alex', 'the-password'), '10.0.0.10')).toBe('ok');
    clock += 5 * 60_000 + 1;
    expect(await access.authorize(basic('alex', 'the-password'), '10.0.0.9')).toBe('ok');
  });

  it('reports the zero-config default: off, nothing configured, nothing listening', async () => {
    expect(await lan().status(true)).toMatchObject({
      available: true, editable: true, lanAccess: false, active: false, authConfigured: false, username: null, lanUrls: [],
    });
  });
});

// The LAN side binds 127.0.0.2: a second address the loopback listener does not hold, which
// Linux and Windows route to loopback out of the box. macOS only configures 127.0.0.1.
describe.skipIf(process.platform === 'darwin')('LAN listener through startServer', () => {
  const LAN_IP = '127.0.0.2';
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let server: ReturnType<typeof startServer> | undefined;
  let port: number;
  let config: ReturnType<typeof memoryConfig>;
  let access: LanAccess;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-lan-'));
    home = mkdtempSync(join(tmpdir(), 'cez-lan-home-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    config = memoryConfig();
    access = new LanAccess({
      hashPassword, verifyPassword, parseBasicAuth, safeEqualString, loadOrCreateCert,
      available: () => true,
      config,
      addresses: () => [LAN_IP],
      certDir: () => join(home, 'certs'),
    });
    server = startServer({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      lanAccess: access,
    }, 0);
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    port = (server.address() as { port: number }).port;
    // attach() runs on `listening` too; let it settle before the first apply.
    await access.close();
  });

  afterEach(async () => {
    await access.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = undefined;
    store.flush();
    // On Windows a background `git` the health/skills probes spawned can still hold the repo as
    // its cwd; a leaked temp dir is not a failure of the code under test.
    for (const dir of [repoRoot, home]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* see above */ }
    }
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
  const collect = (resolve: (reply: Reply) => void) => (res: import('node:http').IncomingMessage) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
  };
  const loopback = (method: string, path: string, json?: unknown) => new Promise<Reply>((resolve, reject) => {
    const payload = json === undefined ? undefined : JSON.stringify(json);
    const req = httpRequest({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, collect(resolve));
    req.on('error', reject);
    req.end(payload);
  });
  const ca = () => readFileSync(join(home, 'certs', 'cezar-cert.pem'), 'utf8');
  const overLan = (method: string, path: string, headers: Record<string, string> = {}, json?: unknown) =>
    new Promise<Reply>((resolve, reject) => {
      const payload = json === undefined ? undefined : JSON.stringify(json);
      const req = httpsRequest({
        host: LAN_IP, port, method, path, agent: false, ca: ca(), servername: LAN_IP,
        headers: { host: `${LAN_IP}:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
      }, collect(resolve));
      req.on('error', reject);
      req.end(payload);
    });
  const enable = async () => {
    const reply = await loopback('PUT', '/api/v1/security/lan', { lanAccess: true, username: 'alex', password: 'lan-password' });
    expect(reply.status).toBe(200);
    return JSON.parse(reply.body) as { active: boolean; lanUrls: string[]; certFingerprint: string | null };
  };
  const AUTH = { authorization: basic('alex', 'lan-password') };

  it('stays loopback-only until LAN access is switched on from this machine', async () => {
    const status = JSON.parse((await loopback('GET', '/api/v1/security/lan')).body);
    expect(status).toMatchObject({ available: true, editable: true, lanAccess: false, active: false });
    await expect(overLan('GET', '/api/v1/health', AUTH)).rejects.toThrow();
    expect(config.current.security).toBeUndefined();
  });

  it('serves the LAN over TLS behind Basic Auth, scoped as a remote client', async () => {
    const status = await enable();
    expect(status.active).toBe(true);
    expect(status.lanUrls).toEqual([`https://${LAN_IP}:${port}`]);
    expect(status.certFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const anonymous = await overLan('GET', '/');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Basic realm="cezar"');
    expect((await overLan('GET', '/api/v1/health', { authorization: basic('alex', 'wrong-password') })).status).toBe(401);

    const health = await overLan('GET', '/api/v1/health', AUTH);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).capabilities).toMatchObject({ localHandoff: false, terminal: false, designMode: false });
    // The host's own browser keeps its desktop capabilities and needs no password.
    expect(JSON.parse((await loopback('GET', '/api/v1/health')).body).capabilities.localHandoff).toBe(true);
  });

  it('a LAN read that refreshes the shared health cache never changes what loopback sees', async () => {
    await enable();
    expect(JSON.parse((await loopback('GET', '/api/v1/health')).body).capabilities.localHandoff).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5_200)); // past the 5 s TTL: the next read refreshes
    expect(JSON.parse((await overLan('GET', '/api/v1/health', AUTH)).body).capabilities.localHandoff).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000)); // let that background refresh land
    const local = JSON.parse((await loopback('GET', '/api/v1/health')).body);
    expect(local.capabilities.localHandoff).toBe(true);
    expect(local.repoRoot).toBe(repoRoot);
  }, 20_000);

  it('rejects a foreign Host on the LAN side even with valid credentials (DNS rebinding)', async () => {
    await enable();
    const rebound = await overLan('GET', '/api/v1/health', { ...AUTH, host: `rebind.attacker.test:${port}` });
    expect(rebound.status).toBe(403);
  });

  it('never lets a LAN client change LAN access', async () => {
    await enable();
    const reply = await overLan('PUT', '/api/v1/security/lan', { ...AUTH, origin: `https://${LAN_IP}:${port}` }, { lanAccess: false });
    expect(reply.status).toBe(409);
    expect(JSON.parse((await overLan('GET', '/api/v1/security/lan', AUTH)).body)).toMatchObject({ editable: false, active: true });
  });

  it('redirects plain HTTP on the LAN port to HTTPS', async () => {
    await enable();
    const reply = await new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ host: LAN_IP, port, path: '/tasks?x=1', agent: false, headers: { host: `${LAN_IP}:${port}` } }, collect(resolve));
      req.on('error', reject);
      req.end();
    });
    expect(reply.status).toBe(308);
    expect(reply.headers.location).toBe(`https://${LAN_IP}:${port}/tasks?x=1`);
  });

  it('refuses every WebSocket over the LAN, signed in or not, and still admits loopback', async () => {
    await enable();
    expect((await overLan('GET', '/api/v1/health', AUTH)).status).toBe(200); // the page signed in first
    const open = (url: string, headers: Record<string, string>, tls: boolean) => new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url, { ...(tls ? { ca: ca(), servername: LAN_IP } : {}), headers });
      socket.once('open', () => { socket.close(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('unexpected-response', () => resolve(false));
      socket.once('close', () => resolve(false)); // a refused handshake may only ever close
    });
    const lanOrigin = `https://${LAN_IP}:${port}`;
    expect(await open(`wss://${LAN_IP}:${port}/api/v1/ws`, { ...AUTH, origin: lanOrigin }, true)).toBe(false);
    expect(await open(`wss://${LAN_IP}:${port}/api/v1/ws`, { origin: lanOrigin }, true)).toBe(false);
    // The loopback cockpit's socket is untouched (#426 rules).
    expect(await open(`ws://127.0.0.1:${port}/api/v1/ws`, { origin: `http://127.0.0.1:${port}` }, false)).toBe(true);
  });

  it('switching off closes the listener and drops LAN sessions already open', async () => {
    await enable();
    // A signed-in keep-alive connection — what a LAN browser's SSE stream rides on.
    const agent = new HttpsAgent({ keepAlive: true, ca: ca() });
    const held = await new Promise<Socket>((resolve, reject) => {
      const req = httpsRequest({ host: LAN_IP, port, path: '/api/v1/health', agent, headers: { host: `${LAN_IP}:${port}`, ...AUTH } }, (res) => {
        res.resume();
        res.on('end', () => resolve(req.socket!));
      });
      req.on('error', reject);
      req.end();
    });
    const closed = new Promise<void>((resolve) => held.once('close', () => resolve()));
    const reply = await loopback('PUT', '/api/v1/security/lan', { lanAccess: false });
    expect(JSON.parse(reply.body)).toMatchObject({ lanAccess: false, active: false, authConfigured: true });
    await closed;
    agent.destroy();
    await expect(overLan('GET', '/api/v1/health', AUTH)).rejects.toThrow();
    expect((await loopback('GET', '/api/v1/health')).status).toBe(200);
  });

  it('respects CEZ_LAN_ACCESS=0 to disable LAN access completely', async () => {
    process.env.CEZ_LAN_ACCESS = '0';
    try {
      const s = startServer({
        repoRoot, store,
        manager: { isActive: () => false } as unknown as RunManager,
        version: '0.0.0-test',
        providerAuth: connectedProviderAuth(),
      }, 0);
      await new Promise<void>((resolve) => s.once('listening', () => resolve()));
      const testPort = (s.address() as { port: number }).port;
      const res = await new Promise<Reply>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: testPort, method: 'GET', path: '/api/v1/security/lan', agent: false }, collect(resolve));
        req.on('error', reject);
        req.end();
      });
      expect(JSON.parse(res.body)).toMatchObject({ available: false, editable: false });
      await new Promise<void>((resolve) => s.close(() => resolve()));
    } finally {
      delete process.env.CEZ_LAN_ACCESS;
    }
  });
});

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createApp, WorkspaceEventBus, type ServerDeps } from '../server/server.ts';
import { resolveCapabilities } from '../server/capabilities.ts';
import type { SocketHub, TopicPublisher } from '../server/ws.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { FakeRelay } from './fake-relay.testkit.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { inRelayScope, narrowForRelay, outsideRelayScope, runInRelayScope } from './scope.ts';
import { RelayService } from './service.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

/** Each case here is proved red without its change, by the AGENTS.md rule. See the PR body. */

const ORIGIN = 'https://relay.example.test';
const SAVED = ['CEZ_HOME', 'CEZ_REMOTE', 'CEZ_RELAY_URL', 'CEZ_RELAY', 'CEZ_TERMINAL', 'CEZ_REMOTE_AGENT_ACCOUNTS', 'CEZ_WEBHOOKS', 'CEZ_DRY_RUN', 'CEZ_DESIGN_MODE'] as const;
const DEVICE = 'dXtIS8djB99atVWpeg3BQw';
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('a relay request is a hosted request', () => {
  const saved = new Map<string, string | undefined>();
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    for (const key of SAVED) saved.set(key, process.env[key]);
    for (const key of SAVED) delete process.env[key];
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-relay-auth-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-relay-auth-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_RELAY_URL = ORIGIN;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const key of SAVED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });
  /** In the scope, with no Host at all: a local guard would answer 403 to this. */
  const asPhone = (app: ReturnType<typeof makeApp>, path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(runInRelayScope({ deviceId: DEVICE }, () => app.request(path, init)));
  const put = (body: unknown): RequestInit => ({ method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

  describe('narrowForRelay', () => {
    const local = resolveCapabilities({ CEZ_RELAY_URL: ORIGIN, CEZ_TERMINAL: '1' });

    it('returns its input outside a scope', () => {
      expect(narrowForRelay(local)).toBe(local);
      expect(local).toMatchObject({ localHandoff: true, terminal: true, phonePairing: true });
    });

    it('turns off every local power in a scope, even CEZ_TERMINAL=1', () => {
      const narrowed = runInRelayScope({ deviceId: DEVICE }, () => narrowForRelay({ ...local, designMode: true, managerSystemNotifications: true }));
      expect(narrowed).toMatchObject({ localHandoff: false, terminal: false, designMode: false, managerSystemNotifications: false, phonePairing: false });
    });

    it('keeps what a hosted cockpit has', () => {
      const narrowed = runInRelayScope({ deviceId: DEVICE }, () => narrowForRelay(local));
      expect(narrowed).toMatchObject({ managers: local.managers, automations: local.automations, dispatch: local.dispatch });
    });

    it('outsideRelayScope leaves it', () => {
      const scoped = runInRelayScope({ deviceId: DEVICE }, () => outsideRelayScope(() => inRelayScope()));
      expect(scoped).toBe(false);
    });
  });

  describe('capability consent', () => {
    it('unset, invalid or CEZ_RELAY=0 mean no phonePairing', () => {
      expect(resolveCapabilities({}).phonePairing).toBe(false);
      expect(resolveCapabilities({ CEZ_RELAY_URL: 'http://relay.example.test' }).phonePairing).toBe(false);
      expect(resolveCapabilities({ CEZ_RELAY_URL: ORIGIN, CEZ_RELAY: '0' }).phonePairing).toBe(false);
      expect(resolveCapabilities({ CEZ_RELAY_URL: ORIGIN }).phonePairing).toBe(true);
    });
  });

  describe('guards', () => {
    it('the Host allowlist reads the narrowed value, so a tunnel request is hosted', async () => {
      const app = makeApp();
      expect((await app.request('/api/v1/workspace/config')).status).toBe(403);
      expect((await asPhone(app, '/api/v1/workspace/config')).status).toBe(200);
    });

    it('a concurrent loopback request stays local', async () => {
      const app = makeApp();
      const [phone, desktop] = await Promise.all([
        asPhone(app, '/api/v1/health'),
        apiRequest(app, '/api/v1/health'),
      ]);
      expect((await phone.json() as { capabilities: { localHandoff: boolean } }).capabilities.localHandoff).toBe(false);
      expect((await desktop.json() as { capabilities: { localHandoff: boolean } }).capabilities.localHandoff).toBe(true);
    });

    it('/health in a scope trims repoRoot and narrows capabilities', async () => {
      const body = await (await asPhone(makeApp(), '/api/v1/health')).json() as { repoRoot: string; capabilities: Record<string, boolean> };
      expect(body.repoRoot).not.toContain('/');
      expect(body.capabilities).toMatchObject({ localHandoff: false, terminal: false, phonePairing: false });
    });
  });

  describe('each power localHandoff gates', () => {
    it('agent-config PUT', async () => {
      const app = makeApp();
      const res = await asPhone(app, '/api/v1/agent-config/claude.project.settings', put({ content: '{"hooks":{}}', version: null }));
      expect(res.status).toBe(409);
      expect((await apiRequest(app, '/api/v1/agent-config/claude.project.settings', put({ content: '{}', version: null }))).status).toBe(200);
    });

    it('open-in, for a project and for a run', async () => {
      const app = makeApp({ openFile: async () => { throw new Error('must not open'); } });
      const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
      const refusal = 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)';
      for (const path of ['/api/v1/open-in', `/api/v1/runs/${run.id}/open-in`]) {
        const res = await asPhone(app, path, post({ target: 'finder' }));
        expect(res.status, path).toBe(409);
        expect(await res.json()).toEqual({ error: refusal });
      }
      expect((await asPhone(app, `/api/v1/runs/${run.id}/open-in-cli`, { method: 'POST' })).status).toBe(409);
      expect(await (await asPhone(app, '/api/v1/open-targets')).json()).toEqual({ targets: [] });
    });

    it('terminal', async () => {
      process.env.CEZ_TERMINAL = '1';
      const app = makeApp();
      const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
      const res = await asPhone(app, `/api/v1/runs/${run.id}/terminal`, post({ cols: 80, rows: 24 }));
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('terminal is disabled');
    });

    it('adding a project outside the browse root', async () => {
      const app = makeApp();
      const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-relay-auth-outside-'));
      await apiRequest(app, '/api/v1/workspace/config', put({ browseRoot: home }));
      const phone = await asPhone(app, '/api/v1/projects', post({ root: outside }));
      expect(phone.status).toBe(400);
      expect(await phone.json()).toEqual({ error: 'folder is outside the browsable root' });
      expect((await apiRequest(app, '/api/v1/projects', post({ root: outside }))).status).not.toBe(400);
      rmSync(outside, { recursive: true, force: true });
    });

    it('design proxy', async () => {
      const res = await asPhone(makeApp(), '/api/v1/preview/design-proxy', post({ target: 'http://127.0.0.1:3000', parentOrigin: 'http://127.0.0.1:4321' }));
      expect(res.status).toBe(409);
    });
  });

  describe('agent accounts', () => {
    const body = { provider: 'claude', configDir: '/tmp/evil', label: 'x' };

    it('are refused in a scope', async () => {
      expect((await asPhone(makeApp(), '/api/v1/workspace/agent-profiles', post(body))).status).toBe(409);
    });

    it('are refused even with CEZ_REMOTE_AGENT_ACCOUNTS=1', async () => {
      process.env.CEZ_REMOTE_AGENT_ACCOUNTS = '1';
      expect((await asPhone(makeApp(), '/api/v1/workspace/agent-profiles', post(body))).status).toBe(409);
    });

    it('a desktop still lists them', async () => {
      expect((await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles')).status).toBe(200);
    });
  });

  describe('phones', () => {
    const routes: [string, string][] = [
      ['GET', '/api/v1/workspace/phones'],
      ['POST', '/api/v1/workspace/phones/pairing'],
      ['POST', '/api/v1/workspace/phones/pairing/00000000-0000-4000-8000-000000000000/approve'],
      ['POST', '/api/v1/workspace/phones/pairing/00000000-0000-4000-8000-000000000000/deny'],
      ['DELETE', `/api/v1/workspace/phones/${DEVICE}`],
    ];

    it.each(routes)('%s %s answers 403 in a scope', async (method, path) => {
      const res = await asPhone(makeApp(), path, { method });
      expect(res.status).toBe(403);
    });

    it('PATCH answers 403 in a scope', async () => {
      const res = await asPhone(makeApp(), `/api/v1/workspace/phones/${DEVICE}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ label: 'x' }) });
      expect(res.status).toBe(403);
    });

    it('answers 409 with the feature off', async () => {
      delete process.env.CEZ_RELAY_URL;
      expect((await apiRequest(makeApp(), '/api/v1/workspace/phones')).status).toBe(409);
    });

    it('lists for a desktop', async () => {
      const res = await apiRequest(makeApp(), '/api/v1/workspace/phones');
      expect(await res.json()).toMatchObject({ relayOrigin: ORIGIN, relay: { status: 'off' }, phones: [], pairing: null });
    });
  });

  describe('routes hosted mode does not gate', () => {
    it('PUT /workspace/config refuses browseRoot and projectsDir, and other fields save', async () => {
      const app = makeApp();
      expect((await asPhone(app, '/api/v1/workspace/config', put({ browseRoot: '/' }))).status).toBe(403);
      expect((await asPhone(app, '/api/v1/workspace/config', put({ projectsDir: '/tmp' }))).status).toBe(403);
      const saved = await asPhone(app, '/api/v1/workspace/config', put({ systemPrompt: 'hello' }));
      expect(saved.status).toBe(200);
    });

    it('every /webhooks write answers 403, flag or no flag', async () => {
      const app = makeApp();
      const writes: [string, string][] = [
        ['POST', '/api/v1/webhooks'],
        ['POST', '/api/v1/webhooks/notice/acknowledge'],
        ['PATCH', '/api/v1/webhooks/x'],
        ['DELETE', '/api/v1/webhooks/x'],
        ['POST', '/api/v1/webhooks/x/test'],
        ['POST', '/api/v1/webhooks/x/rotate-secret'],
      ];
      for (const [method, path] of writes) {
        expect((await asPhone(app, path, { method, headers: JSON_HEADERS, body: '{}' })).status, path).toBe(403);
      }
    });
  });

  describe('the scope does not leak', () => {
    const readFrames = async (response: Response, until: (text: string) => boolean): Promise<string> => {
      const reader = response.body!.getReader();
      let text = '';
      for (let i = 0; i < 50 && !until(text); i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      await reader.cancel();
      return text;
    };

    it('phone-pairing events reach a desktop stream and never a relay stream', async () => {
      const workspaceEvents = new WorkspaceEventBus();
      const app = makeApp({ workspaceEvents });
      const desktop = await apiRequest(app, '/api/v1/workspace/events');
      const phone = await asPhone(app, '/api/v1/workspace/events');
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Emitted from inside a scope, so the listener would read the emitter's scope if it asked.
      runInRelayScope({ deviceId: DEVICE }, () => {
        workspaceEvents.emit('phone-pairing', { pairing: null });
        workspaceEvents.emit('tracker-changed', { project: 'marker' });
      });
      outsideRelayScope(() => workspaceEvents.emit('phone-pairing', { pairing: null }));
      const seenByDesktop = await readFrames(desktop, (text) => text.includes('tracker-changed'));
      const seenByPhone = await readFrames(phone, (text) => text.includes('tracker-changed'));
      expect(seenByDesktop).toContain('phone-pairing');
      expect(seenByPhone).toContain('tracker-changed');
      expect(seenByPhone).not.toContain('phone-pairing');
    });

    it('an SSE handler captures capabilities at open', () => {
      const source = readFileSync(join(import.meta.dirname, '../server/server.ts'), 'utf8');
      const handlers = source.split('streamSSENoBuffer(c, async (stream) => {').slice(1);
      expect(handlers.length).toBeGreaterThanOrEqual(3);
      for (const body of handlers) expect(body.slice(0, body.search(/\n {6}\}\);\n/))).not.toMatch(/\bcapabilities\(\)/);
    });

    describe('health', () => {
      const hub = () => {
        const topics = new Map<string, TopicPublisher>();
        const socketHub: SocketHub = {
          registerTopic: (name, publisher) => { topics.set(name, publisher); return () => { topics.delete(name); }; },
          attach: () => undefined,
          close: () => undefined,
        };
        return { socketHub, topics };
      };

      it('a phone reads narrowed while the cache holds the desktop view', async () => {
        const { socketHub } = hub();
        const app = makeApp({ socketHub });
        await apiRequest(app, '/api/v1/health');
        const phone = await (await asPhone(app, '/api/v1/health')).json() as { repoRoot: string; capabilities: { localHandoff: boolean } };
        expect(phone.capabilities.localHandoff).toBe(false);
        expect(phone.repoRoot).not.toContain('/');
        const desktop = await (await apiRequest(app, '/api/v1/health')).json() as { repoRoot: string; capabilities: { localHandoff: boolean } };
        expect(desktop.capabilities.localHandoff).toBe(true);
        expect(desktop.repoRoot).toBe(repoRoot);
      });

      it('a refresh from a scope publishes the desktop view, and a desktop reads it', async () => {
        const { socketHub, topics } = hub();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const app = makeApp({ socketHub });
          const published: { repoRoot: string; capabilities: { localHandoff: boolean } }[] = [];
          const stop = topics.get('health')!.start((data) => published.push(data as never));
          await apiRequest(app, '/api/v1/health');
          process.env.CEZ_HOME = home;
          vi.setSystemTime(Date.now() + 120_000);
          // Past the staleness ceiling, this read recomputes inside the scope.
          await asPhone(app, '/api/v1/health');
          for (const item of published) {
            expect(item.capabilities.localHandoff).toBe(true);
            expect(item.repoRoot).toBe(repoRoot);
          }
          const snapshot = await topics.get('health')!.snapshot() as { capabilities: { localHandoff: boolean } };
          expect(snapshot.capabilities.localHandoff).toBe(true);
          stop();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('a run started from a scope reads the unscoped value', async () => {
      const seen: boolean[] = [];
      const execute = vi.spyOn(RunManager.prototype as never as { execute: () => Promise<void> }, 'execute')
        .mockImplementation(async () => { seen.push(inRelayScope()); });
      try {
        const manager = new RunManager(store, repoRoot);
        const workflow = { name: 'w', steps: [{ id: 'a', prompt: 'x' }] };
        runInRelayScope({ deviceId: DEVICE }, () => manager.startRun(workflow as never, { task: 't' } as never));
        for (let i = 0; i < 100 && seen.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        manager.dispose();
        expect(seen).toEqual([false]);
      } finally {
        execute.mockRestore();
      }
    });

    it('a lazily built project context reads the unscoped value', async () => {
      const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'p', root: repoRoot, name: 'p', status: 'ok' }] as never });
      const built: boolean[] = [];
      contexts.onContextBuilt(() => built.push(inRelayScope()));
      contexts.onStoreCreated(() => built.push(inRelayScope()));
      await runInRelayScope({ deviceId: DEVICE }, () => contexts.context('p'));
      expect(built).toEqual([false, false]);
      contexts.disposeAll();
    });

    it('a pairing started in a scope would not carry it, were the route ever reached', async () => {
      const relay = new FakeRelay();
      const service = new RelayService({ directory: join(home, 'r'), env: { CEZ_RELAY_URL: ORIGIN }, open: relay.open });
      service.attach(async () => new Response('ok'), () => {});
      const started = await runInRelayScope({ deviceId: DEVICE }, () => service.startPairing());
      expect(started.relayOrigin).toBe(ORIGIN);
      service.dispose();
    });
  });

  describe('over the tunnel, end to end', () => {
    const tunnel = async () => {
      const relay = new FakeRelay();
      const service = new RelayService({ directory: join(home, 'relay'), open: relay.open, label: 'Test Mac' });
      const app = makeApp({ relay: service });
      const started = await service.startPairing();
      const phone = new PhoneSim(relay.open);
      await phone.pairWithQr(started.qr);
      for (let i = 0; i < 200 && service.list().pairing?.status !== 'confirm'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      service.approvePairing(started.id);
      await phone.outcome();
      await phone.connect();
      return { app, phone, service };
    };

    it('a forged Host: 127.0.0.1 stays hosted', async () => {
      const { phone, service } = await tunnel();
      const health = await phone.fetch('GET', '/api/v1/health', [['host', '127.0.0.1:4321'], ['origin', 'http://127.0.0.1:4321'], ['x-forwarded-host', 'localhost']]);
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body.toString())).toMatchObject({ capabilities: { localHandoff: false, terminal: false, phonePairing: false } });
      service.dispose();
    });

    it('a phone cannot pair another phone or edit agent config', async () => {
      const { phone, service } = await tunnel();
      expect((await phone.fetch('POST', '/api/v1/workspace/phones/pairing', [['host', '127.0.0.1:4321']])).status).toBe(403);
      const config = await phone.fetch('PUT', '/api/v1/agent-config/claude.project.settings', [['host', 'localhost'], ['content-type', 'application/json']], '{"content":"{}","version":null}');
      expect(config.status).toBe(409);
      service.dispose();
    });
  });

  describe('source walk', () => {
    const root = join(import.meta.dirname, '..');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.ts$/.test(name) && !/\.test\.ts$|\.testkit\.ts$/.test(name) ? [path] : [];
    });
    /** Process-level state, the WebSocket upgrade, or fields `narrowForRelay` leaves alone. */
    const ALLOWED: Record<string, number> = {
      'index.ts': 3, // webhook mode and singleProject at boot; self-update wraps it in narrowForRelay.
      'automations/builtin-skill.ts': 1,
      'workflows/run.ts': 1, // `dispatch`
      'server/capabilities.ts': 8, // the definitions and their internal callers
      'server/server.ts': 6, // the closure, the accounts closure, startServer's flags, verifyWsUpgrade
    };

    it('a new direct read of the boundary in a request path fails here', () => {
      const pattern = /\b(?:resolveCapabilities|agentAccountsEnabled|localHandoffEnabled)\(/g;
      const found: Record<string, number> = {};
      for (const file of files(root)) {
        const text = readFileSync(file, 'utf8').replace(/^\s*(?:\*|\/\/).*$/gm, '');
        const count = text.match(pattern)?.length ?? 0;
        if (count > 0) found[relative(root, file)] = count;
      }
      expect(found).toEqual(ALLOWED);
    });

    it('the closure, the guard and self-update route through the narrowing', () => {
      const server = readFileSync(join(root, 'server/server.ts'), 'utf8');
      expect(server).toContain('const capabilities = () => narrowForRelay(resolveCapabilities(process.env, bindHost));');
      expect(server).toContain('const isHostedMode = () => !capabilities().localHandoff;');
      const index = readFileSync(join(root, 'index.ts'), 'utf8');
      expect(index).toContain('trimPaths: () => !narrowForRelay(resolveCapabilities(process.env, bindHost)).localHandoff');
    });

    it('the sites a behaviour test cannot reach leave the scope too', () => {
      const server = readFileSync(join(root, 'server/server.ts'), 'utf8');
      expect(server).toContain('outsideRelayScope(() => deps.automationsChanged?.())');
      expect(server).toContain('createWebhookRoutes(context => outsideRelayScope(async () => {');
      expect(readFileSync(join(root, 'server/ws.ts'), 'utf8')).toContain('outsideRelayScope(() => state.publisher.start(');
      const engine = readFileSync(join(root, 'managers/engine.ts'), 'utf8');
      expect(engine).toContain('this.timer = outsideRelayScope(() => setTimeout(');
      expect(engine).toContain('const timer = outsideRelayScope(() => setTimeout(');
    });

    it('every run start leaves the scope', () => {
      const run = readFileSync(join(root, 'workflows/run.ts'), 'utf8');
      const starts = run.match(/.*this\.(?:execute|runContinuation)\(.*/g) ?? [];
      expect(starts.length).toBe(3);
      for (const line of starts) expect(line).toContain('outsideRelayScope(');
    });
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * DNS-rebinding guard: in local mode (loopback bind, no `CEZ_REMOTE`) every
 * legitimate caller addresses the cockpit as `localhost` / `127.x` / `[::1]`,
 * so a request whose Host header names anything else can only be a browser
 * that was rebound to 127.0.0.1 by an attacker-controlled DNS name — its
 * requests are same-origin to the attacker's page, and the Host header is the
 * one tell left. The guard turns those into a 403 before any route runs.
 *
 * Hosted mode (`CEZ_REMOTE=1` or a non-loopback bind) is exempt: the operator
 * deliberately exposed the server behind a hostname or proxy this code cannot
 * enumerate. A missing Host header fails closed in local mode; real HTTP/1.1
 * clients always send one, while the in-process test harness must add it.
 */
describe('host-header guard (DNS rebinding)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-hostguard-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-hostguard-repo-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const request = (host: string | null, path = '/api/v1/health', over: Partial<ServerDeps> = {}) =>
    makeApp(over).request(path, host === null ? {} : { headers: { host } });

  it.each(['localhost', 'localhost:4321', '127.0.0.1', '127.0.0.1:4321', '[::1]', '[::1]:4321'])(
    'allows the loopback spelling %s',
    async (host) => {
      const res = await request(host);
      expect(res.status).toBe(200);
    },
  );

  it('rejects a request without a Host header in local mode', async () => {
    const res = await request(null);
    expect(res.status).toBe(403);
  });

  it.each(['attacker.example', 'attacker.example:4321', 'cezar.attacker.example', '192.168.1.10:4321'])(
    'rejects the rebound host %s with 403 on every route',
    async (host) => {
      for (const path of ['/api/v1/health', '/api/v1/projects', '/api/v1/fs/browse?path=', '/api/v1/runs']) {
        const res = await request(host, path);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: 'forbidden: unexpected Host header — this request did not originate from this machine (see #426)',
        });
      }
    },
  );

  it('rejects a rebound POST before the handler can act', async () => {
    const res = await makeApp().request('/api/v1/projects', {
      method: 'POST',
      headers: { host: 'attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ root: repoRoot }),
    });
    expect(res.status).toBe(403);
  });

  it('is exempt in hosted mode (CEZ_REMOTE=1) — the operator fronts it with their own hostname', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await request('cockpit.example.com');
    expect(res.status).toBe(200);
  });

  it('is exempt for a non-loopback bind host — deliberately exposed', async () => {
    const res = await request('cockpit.example.com', '/api/v1/health', { bindHost: '0.0.0.0' });
    expect(res.status).toBe(200);
  });
});

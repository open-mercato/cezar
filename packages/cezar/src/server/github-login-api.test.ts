import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { GithubLoginState } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { GithubLogin } from './github-login.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `POST/GET/DELETE /api/v1/github/login` (spec 2026-10-26-first-run-onboarding): the route over
 *  a scripted login. What it adds on top of the module is the browser hand-off — once per code,
 *  local mode only — and the status mapping for a missing `gh`. */
describe('/api/v1/github/login', () => {
  const savedHome = process.env.HOME;
  const savedCezHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  let home: string;
  let store: RunStore;

  const fakeLogin = (script: GithubLoginState[]): GithubLogin & { cancelled: number } => {
    let state: GithubLoginState = { status: 'idle' };
    const login = {
      cancelled: 0,
      start: () => {
        state = script.shift() ?? state;
        return Promise.resolve(state);
      },
      read: () => state,
      cancel: () => {
        login.cancelled += 1;
        state = { status: 'idle' };
      },
    };
    return login;
  };

  const build = (githubLogin: GithubLogin, openUrl = vi.fn(async () => true)): { app: Hono; openUrl: typeof openUrl } => {
    const repoRoot = join(home, 'boot');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', githubLogin, openUrl });
    return { app, openUrl };
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-gh-login-')));
    process.env.HOME = home;
    process.env.CEZ_HOME = join(home, '.cezar');
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_SINGLE_PROJECT;
  });
  afterEach(() => {
    store.flush();
    for (const [key, value] of [['HOME', savedHome], ['CEZ_HOME', savedCezHome], ['CEZ_REMOTE', savedRemote], ['CEZ_SINGLE_PROJECT', savedSingleProject]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('answers the code and opens the device page once, then GET follows the login to done', async () => {
    const pending: GithubLoginState = { status: 'pending', code: 'C4AD-605F', url: 'https://github.com/login/device' };
    const login = fakeLogin([pending, pending]);
    const { app, openUrl } = build(login);

    const first = await apiRequest(app, '/api/v1/github/login', { method: 'POST' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(pending);
    await apiRequest(app, '/api/v1/github/login', { method: 'POST' });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://github.com/login/device');

    login.read = () => ({ status: 'done' });
    const read = await apiRequest(app, '/api/v1/github/login');
    expect(await read.json()).toEqual({ status: 'done' });
  });

  it('refuses to sign the host in from a hosted cockpit — POST and DELETE start and cancel nothing', async () => {
    process.env.CEZ_REMOTE = '1';
    const login = fakeLogin([{ status: 'pending', code: 'AAAA-1111', url: 'https://github.com/login/device' }]);
    const start = vi.spyOn(login, 'start');
    const { app, openUrl } = build(login);
    const started = await apiRequest(app, '/api/v1/github/login', { method: 'POST' });
    expect(started.status).toBe(409);
    expect(((await started.json()) as { error: string }).error).toMatch(/machine hosting cezar/);
    expect((await apiRequest(app, '/api/v1/github/login', { method: 'DELETE' })).status).toBe(409);
    expect(start).not.toHaveBeenCalled();
    expect(login.cancelled).toBe(0);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('refuses in a single-project workspace, like every other mutating workspace route', async () => {
    process.env.CEZ_SINGLE_PROJECT = '1';
    const login = fakeLogin([{ status: 'pending', code: 'AAAA-1111', url: 'https://github.com/login/device' }]);
    const start = vi.spyOn(login, 'start');
    const { app } = build(login);
    const started = await apiRequest(app, '/api/v1/github/login', { method: 'POST' });
    expect(started.status).toBe(409);
    expect(await started.json()).toEqual({ error: 'single-project mode is enabled; signing in to GitHub is disabled' });
    expect((await apiRequest(app, '/api/v1/github/login', { method: 'DELETE' })).status).toBe(409);
    expect(start).not.toHaveBeenCalled();
    expect(login.cancelled).toBe(0);
  });

  it('answers 503 with the install hint without gh, 500 with gh’s own line otherwise', async () => {
    const missing = build(fakeLogin([{ status: 'failed', error: 'spawn gh ENOENT', notFound: true }]));
    const res = await apiRequest(missing.app, '/api/v1/github/login', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'gh CLI not found — install it from https://cli.github.com', notFound: true });

    const denied = build(fakeLogin([{ status: 'failed', error: 'error: access denied' }]));
    const second = await apiRequest(denied.app, '/api/v1/github/login', { method: 'POST' });
    expect(second.status).toBe(500);
    expect(await second.json()).toEqual({ error: 'error: access denied' });
  });

  it('DELETE cancels the login', async () => {
    const login = fakeLogin([{ status: 'pending', code: 'BBBB-2222', url: 'https://github.com/login/device' }]);
    const { app } = build(login);
    await apiRequest(app, '/api/v1/github/login', { method: 'POST' });
    const res = await apiRequest(app, '/api/v1/github/login', { method: 'DELETE' });
    expect(await res.json()).toEqual({ status: 'idle' });
    expect(login.cancelled).toBe(1);
  });
});

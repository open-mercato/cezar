import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_REFUSAL, demoAllows, demoMode } from './demo.ts';
import { runInRelayScope } from './relay/scope.ts';
import { RunStore } from './runs/store.ts';
import { createApp } from './server/server.ts';
import type { RunManager } from './workflows/run.ts';
import { runShellCheck } from './workflows/landing.ts';

vi.mock('./core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

const SAVED = ['CEZ_HOME', 'CEZ_DEMO', 'CEZ_DRY_RUN', 'CEZ_RELAY_URL'] as const;
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('store-review demo lock-down', () => {
  const saved = new Map<string, string | undefined>();
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    for (const key of SAVED) saved.set(key, process.env[key]);
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-demo-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-demo-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_RELAY_URL = 'https://relay.example.test';
  });

  afterEach(() => {
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const key of SAVED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('needs both CEZ_DEMO=1 and CEZ_DRY_RUN=1', () => {
    expect(demoMode({ CEZ_DEMO: '1' })).toBe(false);
    expect(demoMode({ CEZ_DRY_RUN: '1' })).toBe(false);
    expect(demoMode({ CEZ_DEMO: '1', CEZ_DRY_RUN: '1' })).toBe(true);
  });

  it('lets a phone read anything and change only what the demo shows', () => {
    expect(demoAllows('GET', '/api/v1/workspace/config')).toBe(true);
    for (const [method, path] of [
      ['POST', '/api/v1/runs'],
      ['POST', '/api/v1/p/todo-cli/runs/abc/messages'],
      ['POST', '/api/v1/workspace/questions/k1/answer'],
      ['POST', '/api/v1/workspace/managers/m1/messages'],
      ['POST', '/api/v1/workspace/managers/m1/actions/a1/decision'],
      ['PUT', '/api/v1/workspace/phone/push'],
    ]) expect(demoAllows(method!, path!), `${method} ${path}`).toBe(true);
    for (const [method, path] of [
      ['PUT', '/api/v1/workspace/config'],
      ['PUT', '/api/v1/workflows/quick-task'],
      ['POST', '/api/v1/runs/abc/terminal'],
      ['POST', '/api/v1/runs/abc/git/push'],
      ['POST', '/api/v1/workspace/managers'],
      ['POST', '/api/v1/projects'],
      ['PUT', '/api/v1/agent-config/claude-settings'],
    ]) expect(demoAllows(method!, path!), `${method} ${path}`).toBe(false);
  });

  it('refuses a phone\'s other writes in the app, and only in demo mode', async () => {
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const request = () => {
      const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
      return Promise.resolve(runInRelayScope({ deviceId: 'dXtIS8djB99atVWpeg3BQw' }, () =>
        app.request('/api/v1/workspace/config', { method: 'PUT', headers: JSON_HEADERS, body: '{}' })));
    };
    process.env.CEZ_DRY_RUN = '1';
    expect(await (await request()).text()).not.toContain(DEMO_REFUSAL);
    process.env.CEZ_DEMO = '1';
    const refused = await request();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: DEMO_REFUSAL });
    store.flush();
  });

  it('never runs a shell check in demo mode', async () => {
    const marker = join(repoRoot, 'ran');
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DEMO = '1';
    expect(await runShellCheck(`touch ${marker}; exit 1`, repoRoot)).toEqual({ ok: true, output: 'demo: not run' });
    delete process.env.CEZ_DEMO;
    expect((await runShellCheck('exit 3', repoRoot)).ok).toBe(false);
  });
});

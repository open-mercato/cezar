import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availablePlatformIds, getStrategy } from './strategies.ts';
import { runInstall, runUninstall } from './engine.ts';
import { loadServerState } from './state.ts';
import { createAutoUi } from './ui.ts';
import { nginxVhost } from './platforms/ubuntu-vps.ts';
import type { BackendCheck } from '../core/backend-detect.ts';
import type { Runner } from './types.ts';

const noRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

describe('registry', () => {
  it('resolves ubuntu-vps and lists available ids', () => {
    expect(getStrategy('ubuntu-vps')?.id).toBe('ubuntu-vps');
    expect(getStrategy('nope')).toBeUndefined();
    expect(availablePlatformIds()).toContain('ubuntu-vps');
  });
});

describe('nginxVhost', () => {
  it('points at the loopback port and disables SSE buffering', () => {
    const v = nginxVhost(4321);
    expect(v).toContain('proxy_pass http://127.0.0.1:4321;');
    expect(v).toContain('proxy_buffering off;');
    expect(v).toContain('http2 on;');
    expect(v).toContain('auth_basic_user_file /etc/cezar/htpasswd;');
  });
});

describe('ubuntu-vps dry-run', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-ubuntu-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('walks every Phase-1 step and writes a complete server.json', async () => {
    const strategy = getStrategy('ubuntu-vps')!;
    const res = await runInstall(strategy, {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui: createAutoUi({ 'Missing tools — select the ones to install': [] as string[] }),
      runner: noRunner,
    });
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('ubuntu-vps');
    expect(state.steps.deps?.status).toBe('done');
    expect(state.steps['nginx-proxy']?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');
    expect(state.installed).toBe(true);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RemoteControlStatus } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { RemoteControlService, type RemoteControlProcessStatus } from './remote-control.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const { createApp } = await import('./server.ts');

/**
 * The `/remote-control` family (spec 2026-08-26-remote-control): status/start/stop over an
 * injected service — the routes' own gating (hosted mode) and shape are what is under test,
 * never a real `claude remote-control` process.
 */

/** In-memory stand-in: records calls, answers what each test scripted. */
class FakeRemoteControl extends RemoteControlService {
  calls: Array<{ method: string; root: string; opts?: unknown }> = [];
  next: RemoteControlProcessStatus = { state: 'stopped' };

  override status(root: string): RemoteControlProcessStatus {
    this.calls.push({ method: 'status', root });
    return this.next;
  }

  override start(root: string, opts = {}): Promise<RemoteControlProcessStatus> {
    this.calls.push({ method: 'start', root, opts });
    return Promise.resolve(this.next);
  }

  override stop(root: string): Promise<RemoteControlProcessStatus> {
    this.calls.push({ method: 'stop', root });
    return Promise.resolve({ state: 'stopped' });
  }
}

describe('/api/v1/remote-control', () => {
  let repoRoot: string;
  let store: RunStore;
  let fake: FakeRemoteControl;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-rc-api-'));
    // The suite's tmpdir may itself live INSIDE a git checkout (cezar redirects agent
    // TMPDIR into the repo's `.ai/cezar/tmp`), so "a plain temp dir" is not reliably
    // non-git. The ceiling pins discovery: repoRoot has no `.git` and git may not walk
    // above it, so the non-git cases stay non-git on every machine.
    process.env.GIT_CEILING_DIRECTORIES = dirname(repoRoot);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    fake = new FakeRemoteControl();
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  });

  const app = () =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      remoteControl: fake,
    });

  it('GET answers the composed status for the scoped project', async () => {
    fake.next = {
      state: 'running',
      url: 'https://claude.ai/code?environment=env_x',
      startedAt: '2026-08-26T00:00:00.000Z',
    };
    const res = await apiRequest(app(), '/api/v1/remote-control');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RemoteControlStatus;
    expect(body).toEqual({
      available: true,
      state: 'running',
      url: 'https://claude.ai/code?environment=env_x',
      startedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(fake.calls).toEqual([{ method: 'status', root: repoRoot }]);
  });

  it('POST start runs against the project root and answers the final state', async () => {
    fake.next = { state: 'running', url: 'https://claude.ai/code?environment=env_x' };
    const res = await apiRequest(app(), '/api/v1/remote-control/start', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RemoteControlStatus;
    expect(body.state).toBe('running');
    expect(body.available).toBe(true);
    const call = fake.calls.find((c) => c.method === 'start');
    expect(call?.root).toBe(repoRoot);
    // A non-git root has nothing to isolate — the CLI's same-dir default stands.
    expect((call?.opts as { worktrees?: boolean }).worktrees).toBe(false);
  });

  it('POST start isolates phone-spawned sessions in worktrees when the root is a git repo', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    // `getRepoInfo` also resolves the branch, which needs at least one commit.
    execFileSync(
      'git',
      ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '--quiet'],
      { cwd: repoRoot },
    );
    fake.next = { state: 'running', url: 'https://claude.ai/code?environment=env_x' };
    const res = await apiRequest(app(), '/api/v1/remote-control/start', { method: 'POST' });
    expect(res.status).toBe(200);
    const call = fake.calls.find((c) => c.method === 'start');
    expect((call?.opts as { worktrees?: boolean }).worktrees).toBe(true);
  });

  it('POST start reports a refusal inside the status (200, state error), not a 5xx', async () => {
    fake.next = { state: 'error', error: 'Error: Workspace not trusted. (exited with code 0)' };
    const res = await apiRequest(app(), '/api/v1/remote-control/start', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RemoteControlStatus;
    expect(body.state).toBe('error');
    expect(body.error).toContain('Workspace not trusted');
  });

  it('POST stop answers stopped', async () => {
    const res = await apiRequest(app(), '/api/v1/remote-control/stop', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RemoteControlStatus).state).toBe('stopped');
    expect(fake.calls).toEqual([{ method: 'stop', root: repoRoot }]);
  });

  describe('hosted mode (CEZ_REMOTE=1) — a local-machine affordance, gated like the rest', () => {
    beforeEach(() => {
      process.env.CEZ_REMOTE = '1';
    });

    it('GET degrades to available:false with the reason, without refusing', async () => {
      const res = await apiRequest(app(), '/api/v1/remote-control');
      expect(res.status).toBe(200);
      const body = (await res.json()) as RemoteControlStatus;
      expect(body.available).toBe(false);
      expect(body.reason).toContain('hosted mode');
    });

    it.each(['start', 'stop'] as const)('POST %s answers 409 and never touches the service', async (action) => {
      const res = await apiRequest(app(), `/api/v1/remote-control/${action}`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(fake.calls.filter((c) => c.method !== 'status')).toEqual([]);
    });
  });
});

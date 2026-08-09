import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * Deployment modes + forge seam (cockpit-ui redesign spec): `/api/v1/health`
 * gains `forge` and `capabilities.localHandoff` ADDITIVELY (the pre-forge
 * fields are the protected bookmarklet contract, BACKWARD_COMPATIBILITY.md
 * §2), and the open-in-cli local handoff 409s in hosted mode.
 */

interface HealthBody {
  version: string;
  repoRoot: string;
  repo: unknown;
  checks: unknown[];
  defaultRunner?: string;
  forge: { kind: string; available: boolean; reason?: string } | null;
  capabilities: {
    localHandoff: boolean;
    followups: boolean;
    singleProject: boolean;
    automations: boolean;
    tokenMetrics: boolean;
    tokenUsageMetrics: boolean;
    costMetrics: boolean;
  };
}

describe('GET /api/v1/health — forge + capabilities', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const savedHideTokenMetrics = process.env.CEZ_HIDE_TOKEN_METRICS;
  const savedHideTokenUsage = process.env.CEZ_HIDE_TOKEN_USAGE;
  const savedHideCost = process.env.CEZ_HIDE_COST;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-health-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    // #471: the inbox is opt-in, so an ambient CEZ_FOLLOWUPS on the dev box
    // must not decide what these assertions see.
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_SINGLE_PROJECT;
    // #801: automations are opt-in for the same reason, and the same ambient-env hazard applies.
    delete process.env.CEZ_AUTOMATIONS;
    delete process.env.CEZ_HIDE_TOKEN_METRICS;
    delete process.env.CEZ_HIDE_TOKEN_USAGE;
    delete process.env.CEZ_HIDE_COST;
    // Dry-run keeps the forge probe (and the claude check) off the network,
    // so the assertions are deterministic on any machine.
    process.env.CEZ_DRY_RUN = '1';
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
    if (savedHideTokenMetrics === undefined) delete process.env.CEZ_HIDE_TOKEN_METRICS;
    else process.env.CEZ_HIDE_TOKEN_METRICS = savedHideTokenMetrics;
    if (savedHideTokenUsage === undefined) delete process.env.CEZ_HIDE_TOKEN_USAGE;
    else process.env.CEZ_HIDE_TOKEN_USAGE = savedHideTokenUsage;
    if (savedHideCost === undefined) delete process.env.CEZ_HIDE_COST;
    else process.env.CEZ_HIDE_COST = savedHideCost;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const health = async (over: Partial<ServerDeps> = {}): Promise<HealthBody> => {
    const res = await apiRequest(makeApp(over), '/api/v1/health');
    expect(res.status).toBe(200);
    return (await res.json()) as HealthBody;
  };

  it('local mode: keeps every pre-forge field and adds localHandoff:true + forge:null outside a repo', async () => {
    const body = await health();
    // Protected pre-existing shape — additive only.
    expect(body.version).toBe('0.0.0-test');
    expect(body.repoRoot).toBe(repoRoot);
    expect(body).toHaveProperty('repo');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body).toHaveProperty('defaultRunner');
    // New additive fields.
    expect(body.forge).toBeNull(); // tmp dir — not a git repo, no remote
    expect(body.capabilities).toEqual({
      localHandoff: true,
      followups: false,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  // getRepoInfo needs a resolvable HEAD — an empty commit is enough.
  const initRepo = (remote: string, remoteName = 'origin') => {
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync(
      'git',
      ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd: repoRoot },
    );
    execFileSync('git', ['remote', 'add', remoteName, remote], { cwd: repoRoot });
  };

  it('reports the GitHub forge for a repo with a github.com remote', async () => {
    initRepo('https://github.com/acme/demo.git');
    const body = await health();
    expect(body.forge).toEqual({ kind: 'github', available: true });
  });

  it('reports the GitHub forge for an SSH (scp-like) origin remote', async () => {
    initRepo('git@github.com:acme/demo.git');
    const body = await health();
    expect(body.forge).toEqual({ kind: 'github', available: true });
  });

  it('reports the GitHub forge when the only remote is not named origin', async () => {
    initRepo('git@github.com:acme/demo.git', 'github');
    const body = await health();
    expect(body.forge).toEqual({ kind: 'github', available: true });
  });

  it('reports forge:null for a non-GitHub remote', async () => {
    initRepo('git@gitlab.com:acme/demo.git');
    const body = await health();
    expect(body.forge).toBeNull();
  });

  it('hosted mode via CEZ_REMOTE=1: localHandoff:false', async () => {
    process.env.CEZ_REMOTE = '1';
    const body = await health();
    expect(body.capabilities).toEqual({
      localHandoff: false,
      followups: false,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  it('hosted mode trims repoRoot to a basename — no absolute path/username leak (#431)', async () => {
    process.env.CEZ_REMOTE = '1';
    const body = await health();
    // The absolute checkout path (with the developer's username) must not be exposed to a
    // site/host that reads the CORS-open health endpoint in hosted mode.
    expect(body.repoRoot).toBe(basename(repoRoot));
    expect(body.repoRoot).not.toContain(sep);
    expect(body.repoRoot).not.toBe(repoRoot);
  });

  it('hosted mode via a non-loopback bind host also trims repoRoot (#431)', async () => {
    const body = await health({ bindHost: '0.0.0.0' });
    expect(body.repoRoot).toBe(basename(repoRoot));
  });

  it('hosted mode via a non-loopback bind host: localHandoff:false', async () => {
    const body = await health({ bindHost: '0.0.0.0' });
    expect(body.capabilities).toEqual({
      localHandoff: false,
      followups: false,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  it('a loopback bind host stays local', async () => {
    const body = await health({ bindHost: '127.0.0.1' });
    expect(body.capabilities).toEqual({
      localHandoff: true,
      followups: false,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  // #471 — the inbox capability rides the same payload the UI already reads.
  it('reports followups:false by default — the global inbox is opt-in', async () => {
    expect((await health()).capabilities.followups).toBe(false);
  });

  it('reports followups:true with CEZ_FOLLOWUPS=1', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    expect((await health()).capabilities).toEqual({
      localHandoff: true,
      followups: true,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  // #801 — the automations capability rides the same payload, and is what the cockpit's nav gate
  // reads. Asserted as a whole object so a capability leaking on by accident cannot pass.
  it('reports automations:false by default — GitHub automations are opt-in', async () => {
    expect((await health()).capabilities.automations).toBe(false);
  });

  it('reports automations:true with CEZ_AUTOMATIONS=1', async () => {
    process.env.CEZ_AUTOMATIONS = '1';
    expect((await health()).capabilities).toEqual({
      localHandoff: true,
      followups: false,
      singleProject: false,
      automations: true,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  it('reports tokenMetrics:false with CEZ_HIDE_TOKEN_METRICS=1', async () => {
    process.env.CEZ_HIDE_TOKEN_METRICS = '1';
    expect((await health()).capabilities).toEqual({
      localHandoff: true,
      followups: false,
      singleProject: false,
      automations: false,
      tokenMetrics: false,
      tokenUsageMetrics: false,
      costMetrics: false,
    });
  });

  it('reports independent token-only and cost-only presentation policies', async () => {
    process.env.CEZ_HIDE_TOKEN_USAGE = '1';
    expect((await health()).capabilities).toMatchObject({
      tokenMetrics: false,
      tokenUsageMetrics: false,
      costMetrics: true,
    });
    delete process.env.CEZ_HIDE_TOKEN_USAGE;
    process.env.CEZ_HIDE_COST = '1';
    expect((await health()).capabilities).toMatchObject({
      tokenMetrics: false,
      tokenUsageMetrics: true,
      costMetrics: false,
    });
  });
});

describe('POST /api/v1/runs/:id/open-in-cli — hosted-mode defense in depth', () => {
  let repoRoot: string;
  let store: RunStore;
  let runId: string;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', steps: [] }).id;
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const post = (over: Partial<ServerDeps> = {}) =>
    apiRequest(
      createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over }),
      `/api/v1/runs/${runId}/open-in-cli`,
      { method: 'POST' },
    );

  it('409s with a human reason when CEZ_REMOTE=1 — before any session lookup', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await post();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('hosted mode');
  });

  it('409s the same way on a non-loopback bind host', async () => {
    const res = await post({ bindHost: '192.168.1.20' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('hosted mode');
  });

  it('local mode still reaches the normal session checks (different 409)', async () => {
    const res = await post();
    expect(res.status).toBe(409);
    // steps: [] — no session to resume; proves the hosted gate did NOT fire.
    expect(((await res.json()) as { error: string }).error).toContain('no agent session');
  });

  it('unknown runs still 404 first', async () => {
    process.env.CEZ_REMOTE = '1';
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/runs/nope/open-in-cli', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessLedgerResponseSchema, harnessProbeInputSchema, harnessStartInputSchema } from '@open-mercato/cezar-contract';
import { createLedger, readLedger, saveLedger } from '../harness/ledger.js';
import { acquireIssueClaim } from '../harness/issue-claim.js';
import { HARNESS_FIX_ISSUE, HARNESS_TEXT_ONLY_ERROR } from '../harness/workflows.js';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { connectedProviderAuth } from './provider-auth.testkit.js';
import { opencodeSeatingError } from '../harness/reviewer-binding.js';
import { createApp } from './server.js';
import { agentAccountsPath } from '../paths.ts';
import { apiRequest } from './loopback-request.testkit.js';
import { defaultWorkspaceConfig } from '../workspace/config.ts';

/**
 * The harness API surface (spec 2026-07-23-harness-orchestration, API
 * Contracts): status/probe for the start surface, the ledger read, the
 * `harness` start parameter, and the stage-only publish guards.
 */
describe('harness API', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-harness-api-'));
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: repoRoot });
    dataDir = join(repoRoot, '.ai/cezar');
    // The multi-model feature flag is ON for this suite — it exercises the gated
    // surface; the default-off behavior has its own tests below.
    mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('CEZ_MULTI_MODEL', '1');
    store = RunStore.open(dataDir);
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: input.task, steps: [] });
      },
      isActive: () => false,
      sendMessage: () => false,
      enqueueMessage: () => null,
      deferMessage: () => false,
      continueRun: () => ({ ok: true }),
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      harnessProber: {
        probe: async () => ({ status: 'ready', detail: 'test binding' }),
        probeAll: async (refs) =>
          new Map(
            refs.map((ref) => [
              `${ref.runner}/${ref.model || 'auto'}`,
              { status: 'ready' as const, detail: 'test binding' },
            ]),
          ),
        clearCache: () => undefined,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('the instance feature flag (off by default)', () => {
    const disable = () => vi.stubEnv('CEZ_MULTI_MODEL', '0');

    it('status stays readable and reports enabled:false', async () => {
      disable();
      const res = await apiRequest(app, '/api/v1/harness/status');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    });

    it('probe answers 409 — it spawns live provider transports', async () => {
      disable();
      const res = await post('/api/v1/harness/probe', { roles: { orchestrator: { runner: 'claude', model: '' }, implementer: { runner: 'claude', model: '' }, reviewers: [{ runner: 'claude', model: 'opus' }, { runner: 'codex', model: 'gpt-5.6-sol' }] } });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/disabled/i);
    });

    it('a harness run start answers 409 with the real reason, not "unknown workflow"', async () => {
      disable();
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'standard' },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/CEZ_MULTI_MODEL/);
      expect(captured).toBeUndefined();
    });
  });

  it('refuses a multi-model start when native model settings are locked', async () => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ modelsLocked: true }));
    const res = await post('/api/v1/runs', {
      task: 'Fix issue #642', workflow: HARNESS_FIX_ISSUE, harness: { profile: 'standard' },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/model selection.*unlocked/i);
    expect(captured).toBeUndefined();
  });

  it('rejects read-only harness starts before probing or dispatching a writing workflow', async () => {
    const res = await post('/api/v1/runs', {
      task: 'Fix issue #642',
      workflow: HARNESS_FIX_ISSUE,
      readOnly: true,
      harness: { profile: 'standard' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/read.only/i);
    expect(captured).toBeUndefined();
  });

  it('shares the bounded role-input contract with clients', () => {
    const roles = {
      orchestrator: { runner: 'claude', model: '' },
      implementer: { runner: 'codex', model: '' },
      reviewers: [{ runner: 'claude', model: 'sonnet' }, { runner: 'codex', model: 'gpt-5' }],
    };
    expect(harnessProbeInputSchema.safeParse({}).success).toBe(false);
    for (const reviewers of [[], roles.reviewers.slice(0, 1), [roles.reviewers[0], roles.reviewers[0]],
      [{ runner: 'harness', model: '' }, roles.reviewers[1]],
      [{ runner: 'codex', model: 'x'.repeat(201) }, roles.reviewers[0]]]) {
      expect(harnessStartInputSchema.safeParse({ roles: { ...roles, reviewers } }).success).toBe(false);
      expect(harnessProbeInputSchema.safeParse({ roles: { ...roles, reviewers } }).success).toBe(false);
    }
    expect(harnessStartInputSchema.safeParse({ roles }).success).toBe(true);
    // the lineup the composer now seats for a Claude + OpenCode workspace.
    const claudeOnly = {
      orchestrator: { runner: 'claude', model: 'haiku' },
      implementer: { runner: 'claude', model: 'haiku' },
      reviewers: [{ runner: 'claude', model: 'haiku' }, { runner: 'opencode', model: 'opencode/gpt-5.6-luna' }],
    } as const;
    expect(harnessStartInputSchema.safeParse({ roles: claudeOnly }).success).toBe(true);
    expect(opencodeSeatingError(claudeOnly)).toBeNull();
    expect(harnessStartInputSchema.safeParse({ baseAcknowledgement: {
      configuredBase: 'main', remoteDefault: 'develop', reason: ' ',
    } }).success).toBe(false);
  });

  describe('GET /api/v1/harness/status', () => {
    it('reports config absence honestly', async () => {
      const res = await apiRequest(app, '/api/v1/harness/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean; configured: boolean };
      expect(body.enabled).toBe(true);
      expect(body.configured).toBe(false);
    });

    it('lists the configured model roster when present', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            version: 1,
            models: {
              codex: { adapter: 'command', family: 'openai', model: 'gpt-5.6-sol', roles: ['worker', 'reviewer'] },
              deepseek: { adapter: 'preset', family: 'deepseek', model: 'deepseek-v4-pro', roles: ['reviewer'] },
            },
          },
        }),
        'utf8',
      );
      const res = await apiRequest(app, '/api/v1/harness/status');
      const body = (await res.json()) as {
        configured: boolean;
        models: Array<{ id: string; model?: string; family?: string; roles: string[] }>;
      };
      expect(body.configured).toBe(true);
      const codex = body.models.find((m) => m.id === 'codex');
      expect(codex).toMatchObject({ model: 'gpt-5.6-sol', family: 'openai', roles: ['worker', 'reviewer'] });
      expect(body.models.some((m) => m.id === 'claude')).toBe(true);
    });

    it('marks a binding that makes a runner-backed reviewer\'s exact call as sameAs it, and only that', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            version: 1,
            models: {
              'zen-glm-5.3': {
                adapter: 'preset',
                preset: 'opencode-zen',
                endpoint: 'https://opencode.ai/zen/v1/chat/completions',
                family: 'zhipu',
                model: 'glm-5.3',
                roles: ['reviewer'],
              },
              kimi: { adapter: 'preset', family: 'moonshot', model: 'kimi-code/k3', roles: ['reviewer'] },
            },
          },
        }),
        'utf8',
      );
      const res = await apiRequest(app, '/api/v1/harness/status');
      const body = (await res.json()) as {
        models: Array<{ id: string; sameAs?: { runner: string; model: string } }>;
      };
      expect(body.models.find((m) => m.id === 'zen-glm-5.3')?.sameAs).toEqual({
        runner: 'opencode',
        model: 'opencode/glm-5.3',
      });
      // No twin → the key is absent from the wire, not `null`/`undefined`.
      expect(body.models.find((m) => m.id === 'kimi')).not.toHaveProperty('sameAs');
    });

    it('answers a claude-only roster with no config at all', async () => {
      const res = await apiRequest(app, '/api/v1/harness/status');
      const body = (await res.json()) as { models: Array<{ id: string; roles: string[] }> };
      expect(body.models).toHaveLength(1);
      expect(body.models[0]).toMatchObject({ id: 'claude', roles: ['host', 'reviewer'] });
    });

    it('reports the bundled cez-harness runtime with its pinned vendor commit', async () => {
      const res = await apiRequest(app, '/api/v1/harness/status');
      const body = (await res.json()) as {
        runtime: { installed: boolean; source: string | null; commit: string | null };
      };
      // The packaged vendor/skills tree ships with cezar, so a bare tmp repo
      // still resolves the collection — the self-containment contract (spec
      // 2026-07-24-vendored-cez-skills).
      expect(body.runtime.installed).toBe(true);
      expect(body.runtime.source).toBe('bundled');
      expect(body.runtime.commit).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe('POST /api/v1/harness/probe', () => {
    it('answers the readiness of a runner lineup without any provider config', async () => {
      const res = await post('/api/v1/harness/probe', { roles: { orchestrator: { runner: 'claude', model: '' }, implementer: { runner: 'claude', model: '' }, reviewers: [{ runner: 'claude', model: 'opus' }, { runner: 'codex', model: 'gpt-5.6-sol' }] } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profile: string; ready: boolean; models: Array<{ id: string }> };
      expect(body.profile).toBe('multi');
      expect(body.ready).toBe(true);
      expect(body.models.map((m) => m.id)).toContain('claude');
    });

    // readiness judged the default login, so a project on a signed-out "work"
    // account read ready and probed a login its phases would never use.
    it('judges the account the project selected', async () => {
      mkdirSync(join(repoRoot, 'claude-work'));
      writeFileSync(agentAccountsPath(), JSON.stringify({
        version: 1,
        accounts: [{ id: 'work', provider: 'claude', configDir: join(repoRoot, 'claude-work') }],
        selections: { [repoRoot]: { claude: 'work' } },
      }));
      const auth = connectedProviderAuth();
      vi.spyOn(auth, 'profileStatus').mockResolvedValue({ provider: 'claude', status: 'disconnected', profileId: 'work' });
      const probed = vi.fn();
      const gated = createApp({
        repoRoot,
        store,
        version: '0.0.0-test',
        providerAuth: auth,
        manager: { startRun: () => { throw new Error('must not start'); }, isActive: () => false } as unknown as RunManager,
        harnessProber: { probe: probed, probeAll: probed, clearCache: () => undefined },
      });
      try {
        const res = await apiRequest(gated, '/api/v1/harness/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roles: { orchestrator: { runner: 'claude', model: '' }, implementer: { runner: 'claude', model: '' }, reviewers: [{ runner: 'claude', model: 'opus' }, { runner: 'codex', model: 'gpt-5.6-sol' }] } }),
        });
        expect(await res.json()).toMatchObject({ ready: false, reason: expect.stringMatching(/claude/i) });
        expect(probed).not.toHaveBeenCalled();
      } finally {
        rmSync(agentAccountsPath(), { force: true });
      }
    });

    // named profiles no longer resolve; a probe names its lineup.
    it('rejects a probe that names a profile instead of a lineup', async () => {
      const res = await post('/api/v1/harness/probe', { profile: 'multi' });
      expect(res.status).toBe(400);
    });

    it('rejects a custom advisor whose auth-store credential is redirected', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            models: {
              redirected: {
                adapter: 'preset',
                preset: 'opencode-zen',
                family: 'xiaomi',
                model: 'mimo-v2.5-free',
                roles: ['reviewer'],
                endpoint: 'https://example.invalid/completions',
                authStoreProvider: 'opencode',
              },
            },
          },
        }),
        'utf8',
      );

      const res = await post('/api/v1/harness/probe', {
        roles: {
          orchestrator: { runner: 'claude', model: '' },
          implementer: { runner: 'claude', model: '' },
          reviewers: [
            { runner: 'claude', model: 'sonnet' },
            { runner: 'harness', model: 'redirected', family: 'xiaomi' },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ready: false,
        reason: expect.stringContaining('official preset, provider, and endpoint'),
        models: [],
      });
    });
  });

  describe('GET /api/v1/runs/:id/harness', () => {
    it('returns the ledger when present and 404 when absent', async () => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      expect((await apiRequest(app, `/api/v1/runs/${run.id}/harness`)).status).toBe(404);
      saveLedger(
        dataDir,
        run.id,
        createLedger({ workflow: HARNESS_FIX_ISSUE, requestedProfile: 'standard', subject: { kind: 'brief', text: 'x' } }),
      );
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: number; workflow: string; snapshotSeq: number };
      expect(body.version).toBe(2);
      expect(body.workflow).toBe(HARNESS_FIX_ISSUE);
      expect(body.snapshotSeq).toBe(0);
    });

    it('answers a ledger with a failed council reviewer in a shape the cockpit accepts', async () => {
      // 2026-09-30, run 49ffff20: two Zen free-tier reviewers answered HTTP 403, the driver
      // recorded them with `verdict: null`, and the cockpit's strict parse of this response
      // failed on that one field — the whole models rail and review tab went with it.
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      (ledger as unknown as { councils: unknown[] }).councils = [
        {
          round: 1,
          kind: 'spec',
          verdict: 'request_changes',
          reviewers: [
            { id: 'codex/gpt-6.1-sol', status: 'completed', verdict: 'request_changes', findings: [] },
            { id: 'opencode/opencode/mimo-v2.6-flash-free', runner: 'harness', status: 'failed', verdict: null, findings: [], error: 'HTTP 403' },
          ],
        },
      ];
      saveLedger(dataDir, run.id, ledger);

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness`);
      expect(res.status).toBe(200);
      const parsed = harnessLedgerResponseSchema.safeParse(await res.json());
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
    });

    it('returns 409 for corrupt or future ledger state instead of pretending it is absent', async () => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      const path = join(dataDir, 'runs', `${run.id}.harness.json`);
      writeFileSync(path, '{ interrupted', 'utf8');
      expect((await apiRequest(app, `/api/v1/runs/${run.id}/harness`)).status).toBe(409);
      writeFileSync(path, JSON.stringify({ version: 999 }), 'utf8');
      expect((await apiRequest(app, `/api/v1/runs/${run.id}/harness`)).status).toBe(409);
    });
  });

  describe('POST /api/v1/runs harness parameter', () => {
    it.each(['harness-fix-issue', 'harness-implement-feature'])('rejects %s in a non-Git folder before creating a session', async (workflow) => {
      rmSync(join(repoRoot, '.git'), { recursive: true, force: true });
      const res = await post('/api/v1/runs', { task: 'Fix issue #642', workflow });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/choose.*git repository/i);
      expect(captured).toBeUndefined();
      expect(store.listRuns()).toHaveLength(0);
    });

    it('threads harness params through to the manager for a harness workflow', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'standard', skillProfile: 'open-mercato', issueId: '642' },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness).toEqual({
        profile: 'standard',
        skillProfile: 'open-mercato',
        issueId: '642',
      });
    });

    it('synthesizes the fail-closed standard harness when the request omits harness options', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
      });
      expect(res.status).toBe(201);
      expect(captured?.harness).toMatchObject({
        profile: 'standard',
        skillProfile: 'generic',
      });
    });

    it('rejects a worktree-less harness run before creating it', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        worktree: false,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/isolated git worktree/);
      expect(captured).toBeUndefined();
    });

    it('rejects harness params on a non-harness workflow', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: 'quick-task',
        harness: { profile: 'standard' },
      });
      expect(res.status).toBe(400);
    });

    // a named profile no longer resolves; ignoring it would silently run Claude solo.
    it('rejects a profile its lineup does not derive', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'multi' },
      });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid skill profile before creating the expensive harness run', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { skillProfile: 'open-mercato-ish' },
      });
      expect(res.status).toBe(400);
      expect(captured).toBeUndefined();
    });

    it('rejects variants on a harness run — one staged handoff per issue', async () => {
      const res = await post('/api/v1/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        variants: 2,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/harness/);
    });

    it('blocks a stale configured base before creating a run unless the exact drift is acknowledged', async () => {
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
      git('init', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(repoRoot, 'README.md'), 'x', 'utf8');
      git('add', 'README.md');
      git('commit', '-m', 'base');
      git('branch', 'develop');
      // The remote default is read from the PR-target remote `resolveTaskRemotes` names.
      git('remote', 'add', 'origin', 'https://example.invalid/owner/repo.git');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai/cezar/config.json'),
        JSON.stringify({ baseBranch: 'develop', multiModel: true }),
        'utf8',
      );

      const blocked = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'standard' },
      });
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: string }).error).toMatch(/before worktree creation/i);
      expect(captured).toBeUndefined();

      const accepted = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: {
          profile: 'standard',
          baseAcknowledgement: {
            configuredBase: 'develop',
            remoteDefault: 'main',
            reason: 'This maintenance run intentionally targets the supported develop line.',
          },
        },
      });
      expect(accepted.status).toBe(201);
      expect(captured?.harness?.baseAcknowledgement?.reason).toMatch(/intentionally/);
    });
  });

  describe('stage-only publish guards', () => {
    const mkHarnessRun = (status: 'running' | 'review') => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      store.updateRun(run.id, {
        status,
        harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE },
        worktreePath: repoRoot, // exists — the guard must fire before git work
        branch: 'fix/issue-642',
      });
      return run;
    };

    it('refuses push and PR while a harness run is still before its review gate', async () => {
      const run = mkHarnessRun('running');
      const push = await post(`/api/v1/runs/${run.id}/git/push`, {});
      expect(push.status).toBe(409);
      expect(((await push.json()) as { error: string }).error).toMatch(/stage-only/);
      const pr = await post(`/api/v1/runs/${run.id}/pr`, {});
      expect(pr.status).toBe(409);
      expect(((await pr.json()) as { error: string }).error).toMatch(/stage-only/);
    });

    it('allows push once the harness run parked at review', async () => {
      const run = mkHarnessRun('review');
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      ledger.stage = { status: 'staged', stagedPaths: [] };
      ledger.outcome = { status: 'ready', blockingReasons: [] };
      saveLedger(dataDir, run.id, ledger);
      const push = await post(`/api/v1/runs/${run.id}/git/push`, {});
      const body = (await push.json()) as { error?: string };
      expect(body.error ?? '').not.toMatch(/harness|stage-only|contested/i);
    });

    it('blocks a staged handoff whose durable outcome is still pending', async () => {
      const run = mkHarnessRun('review');
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      ledger.stage = { status: 'staged', stagedPaths: [] };
      saveLedger(dataDir, run.id, ledger);

      const push = await post(`/api/v1/runs/${run.id}/git/push`, {});
      expect(push.status).toBe(409);
      expect(((await push.json()) as { error: string }).error).toMatch(
        /outcome is pending/i,
      );
    });

    it('blocks publishing a pre-release v1 staged review', async () => {
      const run = mkHarnessRun('review');
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      ledger.stage = { status: 'staged', stagedPaths: [] };
      const {
        invocations: _invocations,
        pendingMessages: _pendingMessages,
        outcome: _outcome,
        ...legacy
      } = ledger;
      writeFileSync(
        join(dataDir, 'runs', `${run.id}.harness.json`),
        JSON.stringify({ ...legacy, version: 1 }),
        'utf8',
      );

      const push = await post(`/api/v1/runs/${run.id}/git/push`, {});
      expect(push.status).toBe(409);
      expect(((await push.json()) as { error: string }).error).toMatch(/unsupported version 1/i);
    });

    it('blocks a contested handoff until the user records an explicit acceptance reason', async () => {
      const run = mkHarnessRun('review');
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      ledger.stage = { status: 'staged', stagedPaths: ['src/x.ts'] };
      ledger.outcome = {
        status: 'contested',
        blockingReasons: ['[major] replay race remains'],
      };
      saveLedger(dataDir, run.id, ledger);

      const blocked = await post(`/api/v1/runs/${run.id}/git/push`, {});
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: string }).error).toMatch(/contested/i);

      const accepted = await post(`/api/v1/runs/${run.id}/harness/accept-contested`, {
        reason: 'Reviewed the remaining risk and accepting it for this draft.',
      });
      expect(accepted.status).toBe(200);

      const push = await post(`/api/v1/runs/${run.id}/git/push`, {});
      expect(((await push.json()) as { error?: string }).error ?? '').not.toMatch(/contested/i);
    });

    // Finish ("Accept changes without a PR") skipped the gate publishing applies,
    // so a contested outcome settled as done without its risk ever being accepted.
    it('refuses to accept a contested harness review until its risk is accepted', async () => {
      const run = mkHarnessRun('review');
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      ledger.stage = { status: 'staged', stagedPaths: ['src/x.ts'] };
      ledger.outcome = { status: 'contested', blockingReasons: ['[major] replay race remains'] };
      saveLedger(dataDir, run.id, ledger);

      const blocked = await post(`/api/v1/runs/${run.id}/finish`, {});
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: string }).error).toMatch(/contested/i);
      expect(store.getRun(run.id)?.status).toBe('review');
    });

    it('records a spec-risk reason and resumes a pre-implementation pause', async () => {
      const run = store.createRun({
        title: 't',
        workflow: HARNESS_FIX_ISSUE,
        task: 'Fix issue #642',
        steps: [],
      });
      store.updateRun(run.id, {
        status: 'failed',
        harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE, issueId: '642' },
      });
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'issue', id: '642', text: 'Fix issue #642' },
      });
      ledger.outcome = {
        status: 'contested',
        blockingReasons: ['rollback behavior is unspecified'],
        pendingDecision: {
          kind: 'spec',
          gate: 'pre-implement',
          round: 1,
          findings: ['rollback behavior is unspecified'],
        },
      };
      saveLedger(dataDir, run.id, ledger);

      const accepted = await post(`/api/v1/runs/${run.id}/harness/accept-contested`, {
        reason: 'The operator accepts this bounded migration risk.',
      });

      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ resumed: true });
      const saved = readLedger(dataDir, run.id);
      expect(saved.status).toBe('valid');
      if (saved.status !== 'valid') throw new Error('expected valid ledger');
      expect(saved.ledger.outcome.status).toBe('pending');
      expect(saved.ledger.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'spec.accept', detail: 'pre-implement:1' }),
          expect.objectContaining({
            kind: 'spec.accept.reason',
            detail: 'The operator accepts this bounded migration risk.',
          }),
        ]),
      );
    });

    it('keeps the issue claim when Finish closes a phase session of a still-running harness run', async () => {
      // Finish answers true for an open phase session, but the driver keeps
      // conducting the run afterwards — a freed claim lets a second run take the same issue.
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'Fix issue #642', steps: [] });
      store.updateRun(run.id, {
        status: 'waiting',
        harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE, issueId: '642' },
      });
      const held = acquireIssueClaim(repoRoot, run.id, '642');
      if (!held.ok) throw new Error(held.error);
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'issue', id: '642', text: 'Fix issue #642' },
      });
      ledger.claim = held.claim;
      saveLedger(dataDir, run.id, ledger);
      let active = true;
      const activeApp = createApp({
        repoRoot,
        store,
        manager: { finish: () => true, isActive: () => active } as unknown as RunManager,
        version: '0.0.0-test',
        providerAuth: connectedProviderAuth(),
      });

      const finished = await apiRequest(activeApp, `/api/v1/runs/${run.id}/finish`, { method: 'POST' });

      expect(finished.status).toBe(200);
      expect(acquireIssueClaim(repoRoot, 'next-run', '642')).toMatchObject({ ok: false });

      // Once the run is no longer active, Finish (accepting the review) frees it as before.
      active = false;
      expect((await apiRequest(activeApp, `/api/v1/runs/${run.id}/finish`, { method: 'POST' })).status).toBe(200);
      expect(acquireIssueClaim(repoRoot, 'next-run', '642')).toMatchObject({ ok: true });
    });

    it('releases an issue claim when an inactive harness run is archived', async () => {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      const run = store.createRun({
        title: 't',
        workflow: HARNESS_FIX_ISSUE,
        task: 'Fix issue #642',
        steps: [],
      });
      store.updateRun(run.id, {
        status: 'review',
        harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE, issueId: '642' },
      });
      const held = acquireIssueClaim(repoRoot, run.id, '642');
      expect(held.ok).toBe(true);
      if (!held.ok) throw new Error(held.error);
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'issue', id: '642', text: 'Fix issue #642' },
      });
      ledger.claim = held.claim;
      saveLedger(dataDir, run.id, ledger);

      const archived = await post(`/api/v1/runs/${run.id}/archive`, {});

      expect(archived.status).toBe(200);
      expect(acquireIssueClaim(repoRoot, 'next-run', '642')).toMatchObject({ ok: true });
    });
  });

  // the pause survives a resume until the council re-runs, so a second click while
  // the run was live bought every failed reviewer another paid attempt, or waived quorum; and a
  // decision whose resume failed was kept anyway.
  describe('council decisions', () => {
    const pausedCouncil = (status: 'failed' | 'running') => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      store.updateRun(run.id, { status, harness: { profile: 'multi', workflow: HARNESS_FIX_ISSUE } });
      const ledger = createLedger({ workflow: HARNESS_FIX_ISSUE, requestedProfile: 'multi', subject: { kind: 'brief', text: 'x' } });
      ledger.outcome = {
        status: 'blocked',
        blockingReasons: ['implementation council did not reach quorum'],
        pendingDecision: {
          kind: 'council',
          council: 'implementation',
          round: 1,
          failed: [{ label: 'kimi' }],
          completedCount: 1,
          canProceed: true,
          subjectSha256: 'subject',
        },
      };
      saveLedger(dataDir, run.id, ledger);
      return run.id;
    };
    const decisions = (id: string) => {
      const read = readLedger(dataDir, id);
      return read.status === 'valid' ? read.ledger.decisions.filter((d) => d.kind.startsWith('council.')) : [];
    };
    const decide = (target: Hono, id: string) =>
      apiRequest(target, `/api/v1/runs/${id}/harness/council-decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      });

    it('records a decision for a paused run and resumes it', async () => {
      const id = pausedCouncil('failed');
      const res = await decide(app, id);
      expect(res.status).toBe(200);
      expect(decisions(id)).toHaveLength(1);
    });

    it('refuses a decision while the run is already resuming', async () => {
      const id = pausedCouncil('running');
      const res = await decide(app, id);
      expect(res.status).toBe(409);
      expect(decisions(id)).toEqual([]);
    });

    it('keeps no decision when the run cannot resume', async () => {
      const id = pausedCouncil('failed');
      const refusing = createApp({
        repoRoot,
        store,
        version: '0.0.0-test',
        providerAuth: connectedProviderAuth(),
        manager: { isActive: () => false, continueRun: () => ({ ok: false, error: 'busy' }) } as unknown as RunManager,
      });
      const res = await decide(refusing, id);
      expect(res.status).toBe(409);
      expect(decisions(id)).toEqual([]);
    });
  });

  describe('phase-boundary messages', () => {
    it('persists the dequeue-startup gap before acknowledging a harness message', async () => {
      const run = store.createRun({
        title: 't',
        workflow: HARNESS_FIX_ISSUE,
        task: 'original task',
        steps: [],
      });
      store.updateRun(run.id, {
        status: 'queued',
        harness: {
          profile: 'standard',
          workflow: HARNESS_FIX_ISSUE,
          issueId: '642',
        },
        queuedMessages: [
          {
            id: 'queued-before-dequeue',
            text: 'preexisting queued context',
            createdAt: '2026-07-26T09:00:00.000Z',
          },
        ],
      });

      const res = await post(`/api/v1/runs/${run.id}/messages`, {
        text: 'message sent after dequeue',
        images: [],
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ queuedForPhase: true });
      store.flush();
      const recovered = readLedger(dataDir, run.id);
      expect(recovered.status).toBe('valid');
      if (recovered.status !== 'valid') throw new Error('expected durable harness ledger');
      expect(recovered.ledger.subject.text).toBe(
        'original task\n\npreexisting queued context',
      );
      expect(recovered.ledger.pendingMessages).toEqual([
        expect.objectContaining({ text: 'message sent after dequeue' }),
      ]);
    });

    it('queues a retried phase-boundary message once', async () => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      store.updateRun(run.id, { status: 'queued', harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE } });
      saveLedger(dataDir, run.id, createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      }));
      const body = { text: 'Also handle X.', images: [], idempotencyKey: '0192f2a4-7c1e-7d4a-9b2f-3c4d5e6f7a8b' };

      const first = await post(`/api/v1/runs/${run.id}/messages`, body);
      const retried = await post(`/api/v1/runs/${run.id}/messages`, body);

      expect(await first.json()).toEqual({ queuedForPhase: true });
      expect(await retried.json()).toEqual({ queuedForPhase: true });
      const after = readLedger(dataDir, run.id);
      expect(after.status === 'valid' ? after.ledger.pendingMessages : []).toHaveLength(1);
    });

    // Continue re-queues a harness run that already has a ledger. A message sent
    // while it waited was stacked onto the folded prompt, which the resume ignores — acknowledged,
    // never applied.
    it('routes a message for a resumed harness run waiting in the queue to its ledger', async () => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      store.updateRun(run.id, { status: 'queued', harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE } });
      saveLedger(dataDir, run.id, createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      }));
      const stacking = createApp({
        repoRoot,
        store,
        version: '0.0.0-test',
        providerAuth: connectedProviderAuth(),
        manager: {
          isActive: () => false,
          sendMessage: () => false,
          deferMessage: () => false,
          // The engine stacks onto a run it still holds in its queue.
          enqueueMessage: (runId: string) => {
            const message = { id: 'stacked', text: 'stacked', createdAt: new Date().toISOString() };
            store.updateRun(runId, { queuedMessages: [message] });
            return message;
          },
        } as unknown as RunManager,
      });

      const res = await apiRequest(stacking, `/api/v1/runs/${run.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Also handle X.' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ queuedForPhase: true });
      expect(store.getRun(run.id)?.queuedMessages ?? []).toEqual([]);
      const after = readLedger(dataDir, run.id);
      expect(after.status === 'valid' ? after.ledger.pendingMessages : []).toEqual([
        expect.objectContaining({ text: 'Also handle X.' }),
      ]);
    });

    // no phase reads an attachment, yet a fresh queued harness run stacked one and
    // dropped it at dequeue.
    it('refuses an image for a queued harness run instead of stacking it', async () => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      store.updateRun(run.id, { status: 'queued', harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE } });
      const enqueueMessage = vi.fn(() => ({ id: 'stacked', text: 'x', createdAt: new Date().toISOString() }));
      const stacking = createApp({
        repoRoot,
        store,
        version: '0.0.0-test',
        providerAuth: connectedProviderAuth(),
        manager: {
          isActive: () => false,
          sendMessage: () => false,
          deferMessage: () => false,
          enqueueMessage,
        } as unknown as RunManager,
      });

      const res = await apiRequest(stacking, `/api/v1/runs/${run.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'See the screenshot.', images: [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }] }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(HARNESS_TEXT_ONLY_ERROR);
      expect(enqueueMessage).not.toHaveBeenCalled();
    });

    it('durably queues text for the next harness phase when no session is open', async () => {
      const run = store.createRun({
        title: 't',
        workflow: HARNESS_FIX_ISSUE,
        task: 'x',
        steps: [],
      });
      store.updateRun(run.id, {
        status: 'running',
        harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE },
      });
      saveLedger(
        dataDir,
        run.id,
        createLedger({
          workflow: HARNESS_FIX_ISSUE,
          requestedProfile: 'standard',
          subject: { kind: 'brief', text: 'x' },
        }),
      );

      const res = await post(`/api/v1/runs/${run.id}/messages`, {
        text: 'Preserve the compatibility alias.',
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ queuedForPhase: true });
      const ledger = (await apiRequest(app, `/api/v1/runs/${run.id}/harness`));
      const body = (await ledger.json()) as {
        pendingMessages: Array<{ text: string; consumedAt?: string }>;
      };
      expect(body.pendingMessages).toEqual([
        expect.objectContaining({
          text: 'Preserve the compatibility alias.',
        }),
      ]);
      expect(body.pendingMessages[0]?.consumedAt).toBeUndefined();
      expect(store.readEvents(run.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'user-message',
            text: 'Preserve the compatibility alias.',
            imageCount: 0,
            images: [],
          }),
          expect.objectContaining({
            type: 'harness.message.queued',
            message: expect.objectContaining({
              id: expect.any(String),
            }),
          }),
        ]),
      );
    });
  });

  describe('POST /api/v1/runs harness roles (2026-07-24)', () => {
    const roles = {
      orchestrator: { runner: 'claude', model: 'sonnet' },
      implementer: { runner: 'codex', model: '' },
      reviewers: [
        { runner: 'claude', model: 'opus' },
        { runner: 'codex', model: 'gpt-5.6-sol' },
      ],
    };

    it('threads a sound role selection through to the manager', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness?.roles).toEqual(roles);
    });

    // probes are live, billed calls; a provider the user disabled was probed (and
    // reported ready) before the provider gate refused the start.
    it('never probes a provider the user disabled', async () => {
      const probed: string[] = [];
      let workspace = { ...defaultWorkspaceConfig(), disabledProviders: ['codex' as const] };
      const gated = createApp({
        repoRoot,
        store,
        version: '0.0.0-test',
        providerAuth: connectedProviderAuth(),
        workspaceConfig: {
          load: async () => workspace,
          mergeWrite: async (mutate: (current: typeof workspace) => typeof workspace | void) => {
            workspace = mutate(workspace) ?? workspace;
            return workspace;
          },
        } as unknown as Parameters<typeof createApp>[0]['workspaceConfig'],
        manager: { startRun: () => { throw new Error('must not start'); }, isActive: () => false } as unknown as RunManager,
        harnessProber: {
          probe: async (ref) => {
            probed.push(`${ref.runner}/${ref.model}`);
            return { status: 'ready', detail: 'probed' };
          },
          probeAll: async (refs) => {
            probed.push(...refs.map((ref) => `${ref.runner}/${ref.model}`));
            return new Map(refs.map((ref) => [`${ref.runner}/${ref.model || 'auto'}`, { status: 'ready' as const, detail: 'probed' }]));
          },
          clearCache: () => undefined,
        },
      });
      const send = (path: string, body: unknown) =>
        apiRequest(gated, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

      const probe = await send('/api/v1/harness/probe', { roles });
      expect(await probe.json()).toMatchObject({ ready: false, reason: expect.stringMatching(/codex/i) });
      const start = await send('/api/v1/runs', { task: 'Fix issue #642', workflow: HARNESS_FIX_ISSUE, harness: { roles } });
      expect(start.status).toBe(409);
      expect(probed).toEqual([]);
    });

    // a harness start persisted its attachments and no phase ever saw them.
    it('refuses an attachment on a harness start', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles },
        images: [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }],
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(HARNESS_TEXT_ONLY_ERROR);
      expect(captured).toBeUndefined();
    });

    it('rejects fewer than 2 reviewers', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles: { ...roles, reviewers: [roles.reviewers[0]] } },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/at least 2 reviewers/i);
    });

    it('rejects duplicate reviewers', async () => {
      const res = await post('/api/v1/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles: { ...roles, reviewers: [roles.reviewers[0], roles.reviewers[0]] } },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/unique/i);
    });

    it('rejects a single-family council', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: {
          roles: {
            ...roles,
            reviewers: [
              { runner: 'claude', model: 'opus' },
              { runner: 'claude', model: 'haiku' },
            ],
          },
        },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/famil/i);
    });

    it('accepts a harness advisor reviewer whose family counts toward diversity (2026-07-24)', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            models: {
              kimi: { family: 'moonshot', roles: ['reviewer'], adapter: 'preset' },
            },
          },
        }),
        'utf8',
      );
      const withAdvisor = {
        ...roles,
        reviewers: [
          { runner: 'claude', model: 'opus' },
          { runner: 'harness', model: 'kimi', family: 'moonshot' },
        ],
      };
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles: withAdvisor },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness?.roles).toEqual(withAdvisor);
    });

    it('rejects an advisor ref as orchestrator or implementer', async () => {
      for (const role of ['orchestrator', 'implementer'] as const) {
        const res = await post('/api/v1/runs', {
          task: 'x',
          workflow: HARNESS_FIX_ISSUE,
          harness: { roles: { ...roles, [role]: { runner: 'harness', model: 'kimi', family: 'moonshot' } } },
        });
        expect(res.status).toBe(400);
      }
    });

    it('derives an omitted advisor family from trusted configuration', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            models: {
              kimi: { family: 'moonshot', roles: ['reviewer'], adapter: 'preset' },
            },
          },
        }),
        'utf8',
      );
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: {
          roles: { ...roles, reviewers: [{ runner: 'claude', model: 'opus' }, { runner: 'harness', model: 'kimi' }] },
        },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness?.roles?.reviewers[1]).toMatchObject({
        runner: 'harness',
        model: 'kimi',
        family: 'moonshot',
      });
    });

    it('rejects a client-supplied advisor family that disagrees with trusted configuration', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            models: {
              kimi: { family: 'moonshot', roles: ['reviewer'], adapter: 'preset' },
            },
          },
        }),
        'utf8',
      );
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: {
          roles: {
            ...roles,
            reviewers: [
              { runner: 'claude', model: 'opus' },
              { runner: 'harness', model: 'kimi', family: 'openai' },
            ],
          },
        },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/trusted configuration/);
    });
  });

  /**
   * User request 2026-07-27: read a reviewer's whole thread — the prompt it was
   * given and what it answered. Until this endpoint the only trace of an
   * expensive council member was its verdict, so there was no way to tell
   * whether it had been asked the right question.
   */
  describe('GET /api/v1/runs/:id/harness/invocations/:invocationId', () => {
    const seedRun = (invocations: unknown[]) => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      const artifactDir = join(dataDir, 'runs', `${run.id}-harness`);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'p.md'), 'review this diff', 'utf8');
      writeFileSync(
        join(artifactDir, 'r.json'),
        JSON.stringify({ verdict: 'request_changes', findings: [] }),
        'utf8',
      );
      const ledger = createLedger({
        workflow: HARNESS_FIX_ISSUE,
        requestedProfile: 'standard',
        subject: { kind: 'brief', text: 'x' },
      });
      ledger.invocations = invocations as typeof ledger.invocations;
      saveLedger(dataDir, run.id, ledger);
      return { run, artifactDir };
    };

    const reviewer = (extra: Record<string, unknown>) => ({
      id: 'inv-1',
      phaseId: 'review',
      role: 'reviewer',
      reviewerId: 'codex/gpt',
      binding: { runner: 'codex', model: 'gpt' },
      status: 'completed',
      attempt: 1,
      inputSha256: 'x',
      ...extra,
    });

    it('answers with the prompt and the result the ledger points at', async () => {
      const { run, artifactDir } = seedRun([]);
      const ledger = readLedger(dataDir, run.id);
      if (ledger.status !== 'valid') throw new Error('seed failed');
      ledger.ledger.invocations = [
        reviewer({
          promptPath: join(artifactDir, 'p.md'),
          artifactPath: join(artifactDir, 'r.json'),
        }),
      ] as typeof ledger.ledger.invocations;
      saveLedger(dataDir, run.id, ledger.ledger);

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness/invocations/inv-1`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { prompt: string; result: string; reviewerId: string };
      expect(body.prompt).toBe('review this diff');
      expect(JSON.parse(body.result).verdict).toBe('request_changes');
      expect(body.reviewerId).toBe('codex/gpt');
    });

    it('404s an invocation id that is not in the ledger', async () => {
      const { run } = seedRun([]);

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness/invocations/nope`);

      expect(res.status).toBe(404);
    });

    it('refuses a ledger path that escapes the run artifact directory', async () => {
      const { run } = seedRun([]);
      const ledger = readLedger(dataDir, run.id);
      if (ledger.status !== 'valid') throw new Error('seed failed');
      ledger.ledger.invocations = [
        reviewer({ promptPath: '/etc/passwd', artifactPath: join(dataDir, 'runs.json') }),
      ] as typeof ledger.ledger.invocations;
      saveLedger(dataDir, run.id, ledger.ledger);

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness/invocations/inv-1`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { prompt: string | null; result: string | null };
      expect(body.prompt).toBeNull();
      expect(body.result).toBeNull();
    });

    // agent-output/ is model-writable — a FIFO hung the server and
    // a symlink served any host file.
    it.skipIf(process.platform === 'win32')('serves neither a planted symlink nor a FIFO, and never blocks', async () => {
      const { run, artifactDir } = seedRun([]);
      const output = join(artifactDir, 'agent-output');
      mkdirSync(output, { recursive: true });
      const secret = join(dataDir, 'host-secret.txt');
      writeFileSync(secret, 'host secret', 'utf8');
      symlinkSync(secret, join(output, 'phase-review-result.json'));
      execFileSync('mkfifo', [join(output, 'phase-review-prompt.md')]);
      // A symlinked DIRECTORY on the way: the final component is a plain file behind it.
      symlinkSync(dataDir, join(output, 'packet'));
      const ledger = readLedger(dataDir, run.id);
      if (ledger.status !== 'valid') throw new Error('seed failed');
      ledger.ledger.invocations = [
        reviewer({
          promptPath: join(output, 'phase-review-prompt.md'),
          artifactPath: join(output, 'phase-review-result.json'),
        }),
        reviewer({ id: 'inv-2', artifactPath: join(output, 'packet', 'host-secret.txt') }),
      ] as typeof ledger.ledger.invocations;
      saveLedger(dataDir, run.id, ledger.ledger);

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness/invocations/inv-1`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { prompt: string | null; result: string | null };
      expect(body.result).toBeNull();
      expect(body.prompt).toBeNull();
      const viaDir = await apiRequest(app, `/api/v1/runs/${run.id}/harness/invocations/inv-2`);
      expect(viaDir.status).toBe(200);
      expect(((await viaDir.json()) as { result: string | null }).result).toBeNull();
    }, 10_000);

    it('reports an unrecorded prompt as null rather than failing', async () => {
      const { run } = seedRun([]);
      const ledger = readLedger(dataDir, run.id);
      if (ledger.status !== 'valid') throw new Error('seed failed');
      ledger.ledger.invocations = [reviewer({})] as typeof ledger.ledger.invocations;
      saveLedger(dataDir, run.id, ledger.ledger);

      const res = await apiRequest(app, `/api/v1/runs/${run.id}/harness/invocations/inv-1`);

      expect(res.status).toBe(200);
      expect(((await res.json()) as { prompt: string | null }).prompt).toBeNull();
    });
  });
});

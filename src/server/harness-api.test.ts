import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLedger, saveLedger } from '../harness/ledger.js';
import { HARNESS_FIX_ISSUE } from '../harness/workflows.js';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

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
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: input.task, steps: [] });
      },
      isActive: () => false,
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('GET /api/harness/status', () => {
    it('reports config absence honestly', async () => {
      const res = await apiRequest(app, '/api/harness/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { configured: boolean; profiles: string[] };
      expect(body.configured).toBe(false);
      // `standard` needs no configuration at all — always offered.
      expect(body.profiles).toContain('standard');
    });

    it('lists configured agentHarness profiles and the model roster when present', async () => {
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
            profiles: {
              standard: { workers: [], reviewers: [] },
              multi: { workers: [], reviewers: ['codex', 'deepseek'] },
            },
          },
        }),
        'utf8',
      );
      const res = await apiRequest(app, '/api/harness/status');
      const body = (await res.json()) as {
        configured: boolean;
        profiles: string[];
        models: Array<{ id: string; model?: string; family?: string; roles: string[]; profiles: string[] }>;
      };
      expect(body.configured).toBe(true);
      expect(body.profiles).toEqual(expect.arrayContaining(['standard', 'multi']));
      const codex = body.models.find((m) => m.id === 'codex');
      expect(codex).toMatchObject({ model: 'gpt-5.6-sol', family: 'openai', roles: ['worker', 'reviewer'] });
      expect(codex?.profiles).toContain('multi');
      // The host is always in the roster — `standard` is claude-only.
      expect(body.models.some((m) => m.id === 'claude')).toBe(true);
    });

    it('answers a claude-only roster with no config at all', async () => {
      const res = await apiRequest(app, '/api/harness/status');
      const body = (await res.json()) as { models: Array<{ id: string; roles: string[] }> };
      expect(body.models).toHaveLength(1);
      expect(body.models[0]).toMatchObject({ id: 'claude', roles: ['host', 'reviewer'] });
    });

    it('reports the bundled cez-harness runtime with its pinned vendor commit', async () => {
      const res = await apiRequest(app, '/api/harness/status');
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

  describe('POST /api/harness/probe', () => {
    it('answers standard readiness without any provider config', async () => {
      const res = await post('/api/harness/probe', { profile: 'standard' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profile: string; ready: boolean; models: Array<{ id: string }> };
      expect(body.profile).toBe('standard');
      expect(body.ready).toBe(true);
      expect(body.models.map((m) => m.id)).toContain('claude');
    });

    it('reports non-standard profiles as not yet driven, never silently degrades', async () => {
      const res = await post('/api/harness/probe', { profile: 'multi' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ready: boolean; reason?: string };
      expect(body.ready).toBe(false);
      expect(body.reason).toMatch(/standard/);
    });

    it('rejects an unknown profile', async () => {
      const res = await post('/api/harness/probe', { profile: 'yolo' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/runs/:id/harness', () => {
    it('returns the ledger when present and 404 when absent', async () => {
      const run = store.createRun({ title: 't', workflow: HARNESS_FIX_ISSUE, task: 'x', steps: [] });
      expect((await apiRequest(app, `/api/runs/${run.id}/harness`)).status).toBe(404);
      saveLedger(
        dataDir,
        run.id,
        createLedger({ workflow: HARNESS_FIX_ISSUE, requestedProfile: 'standard', subject: { kind: 'brief', text: 'x' } }),
      );
      const res = await apiRequest(app, `/api/runs/${run.id}/harness`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: number; workflow: string };
      expect(body.version).toBe(1);
      expect(body.workflow).toBe(HARNESS_FIX_ISSUE);
    });
  });

  describe('POST /api/runs harness parameter', () => {
    it('threads harness params through to the manager for a harness workflow', async () => {
      const res = await post('/api/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'standard', issueId: '642' },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness).toEqual({ profile: 'standard', issueId: '642' });
    });

    it('rejects harness params on a non-harness workflow', async () => {
      const res = await post('/api/runs', {
        task: 'x',
        workflow: 'quick-task',
        harness: { profile: 'standard' },
      });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid profile', async () => {
      const res = await post('/api/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'mega' },
      });
      expect(res.status).toBe(400);
    });

    it('rejects variants on a harness run — one staged handoff per issue', async () => {
      const res = await post('/api/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        variants: 2,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/harness/);
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
      const push = await post(`/api/runs/${run.id}/git/push`, {});
      expect(push.status).toBe(409);
      expect(((await push.json()) as { error: string }).error).toMatch(/stage-only/);
      const pr = await post(`/api/runs/${run.id}/pr`, {});
      expect(pr.status).toBe(409);
      expect(((await pr.json()) as { error: string }).error).toMatch(/stage-only/);
    });

    it('allows push once the harness run parked at review', async () => {
      const run = mkHarnessRun('review');
      const push = await post(`/api/runs/${run.id}/git/push`, {});
      // Not the guard: the request proceeds into real git work (which fails
      // differently in this bare fixture).
      const body = (await push.json()) as { error?: string };
      expect(body.error ?? '').not.toMatch(/stage-only/);
    });
  });

  describe('POST /api/runs harness roles (2026-07-24)', () => {
    const roles = {
      orchestrator: { runner: 'claude', model: 'sonnet' },
      implementer: { runner: 'codex', model: '' },
      reviewers: [
        { runner: 'claude', model: 'opus' },
        { runner: 'codex', model: 'gpt-5.6-sol' },
      ],
    };

    it('threads a sound role selection through to the manager', async () => {
      const res = await post('/api/runs', {
        task: 'Build the CSV export module',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness?.roles).toEqual(roles);
    });

    it('rejects fewer than 2 reviewers', async () => {
      const res = await post('/api/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles: { ...roles, reviewers: [roles.reviewers[0]] } },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/at least 2 reviewers/i);
    });

    it('rejects duplicate reviewers', async () => {
      const res = await post('/api/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles: { ...roles, reviewers: [roles.reviewers[0], roles.reviewers[0]] } },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/unique/i);
    });

    it('rejects a single-family council', async () => {
      const res = await post('/api/runs', {
        task: 'x',
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
      const withAdvisor = {
        ...roles,
        reviewers: [
          { runner: 'claude', model: 'opus' },
          { runner: 'harness', model: 'kimi', family: 'moonshot' },
        ],
      };
      const res = await post('/api/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        harness: { roles: withAdvisor },
      });
      expect(res.status).toBe(201);
      expect(captured?.harness?.roles).toEqual(withAdvisor);
    });

    it('rejects an advisor ref as orchestrator or implementer', async () => {
      for (const role of ['orchestrator', 'implementer'] as const) {
        const res = await post('/api/runs', {
          task: 'x',
          workflow: HARNESS_FIX_ISSUE,
          harness: { roles: { ...roles, [role]: { runner: 'harness', model: 'kimi', family: 'moonshot' } } },
        });
        expect(res.status).toBe(400);
      }
    });

    it('rejects an advisor ref without a family (the diversity axis)', async () => {
      const res = await post('/api/runs', {
        task: 'x',
        workflow: HARNESS_FIX_ISSUE,
        harness: {
          roles: { ...roles, reviewers: [{ runner: 'claude', model: 'opus' }, { runner: 'harness', model: 'kimi' }] },
        },
      });
      expect(res.status).toBe(400);
    });
  });
});

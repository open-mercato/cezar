import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLedger, readLedger, saveLedger } from '../harness/ledger.js';
import { acquireIssueClaim } from '../harness/issue-claim.js';
import { HARNESS_FIX_ISSUE } from '../harness/workflows.js';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { connectedProviderAuth } from './provider-auth.testkit.js';
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
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('GET /api/v1/harness/status', () => {
    it('reports config absence honestly', async () => {
      const res = await apiRequest(app, '/api/v1/harness/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { configured: boolean; profiles: string[] };
      expect(body.configured).toBe(false);
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
      const res = await apiRequest(app, '/api/v1/harness/status');
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
      expect(body.models.some((m) => m.id === 'claude')).toBe(true);
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
    it('answers standard readiness without any provider config', async () => {
      const res = await post('/api/v1/harness/probe', { profile: 'standard' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profile: string; ready: boolean; models: Array<{ id: string }> };
      expect(body.profile).toBe('standard');
      expect(body.ready).toBe(true);
      expect(body.models.map((m) => m.id)).toContain('claude');
    });

    it('reports a configured profile as unavailable when its bindings are absent', async () => {
      const res = await post('/api/v1/harness/probe', { profile: 'multi' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ready: boolean; reason?: string };
      expect(body.ready).toBe(false);
      expect(body.reason).toMatch(/cez-setup-harness/);
    });

    it('resolves a configured non-standard profile through the same driver plan', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            models: {
              codex: {
                family: 'openai',
                model: 'gpt-5.6-sol',
                roles: ['worker'],
                commands: { worker: ['codex', 'exec'] },
              },
            },
            profiles: {
              optimized: {
                workers: ['codex'],
                reviewers: [],
                reviewPolicy: { mode: 'advisory' },
              },
            },
          },
        }),
        'utf8',
      );

      const res = await post('/api/v1/harness/probe', { profile: 'optimized' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ready: boolean; profile: string };
      expect(body).toMatchObject({ ready: true, profile: 'optimized' });
    });

    it('rejects an unknown profile', async () => {
      const res = await post('/api/v1/harness/probe', { profile: 'yolo' });
      expect(res.status).toBe(400);
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

    it('rejects an invalid profile', async () => {
      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'mega' },
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
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai/cezar/config.json'),
        JSON.stringify({ baseBranch: 'develop' }),
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

    it('blocks a migrated v1 staged review until v2 recovery verifies an outcome', async () => {
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
      expect(((await push.json()) as { error: string }).error).toMatch(
        /outcome is pending/i,
      );
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

    it('rejects a configured profile that resolves to OpenCode before probing or starting', async () => {
      mkdirSync(join(repoRoot, '.ai'), { recursive: true });
      writeFileSync(
        join(repoRoot, '.ai', 'agentic.config.json'),
        JSON.stringify({
          agentHarness: {
            models: {
              unsafe: {
                family: 'openrouter',
                roles: ['worker'],
                commands: { worker: ['opencode', 'run'] },
              },
            },
            profiles: {
              optimized: {
                workers: ['unsafe'],
                reviewers: [],
                reviewPolicy: { mode: 'advisory' },
              },
            },
          },
        }),
        'utf8',
      );

      const res = await post('/api/v1/runs', {
        task: 'Fix issue #642',
        workflow: HARNESS_FIX_ISSUE,
        harness: { profile: 'optimized' },
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /OpenCode.*stage-only isolation/i,
      );
      expect(captured).toBeUndefined();
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

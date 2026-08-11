import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, projectRouteManifest, type ProjectRouteInfo } from './server.ts';

/**
 * Alias parity for the mirrored project-route table (spec
 * 2026-07-20-multi-project-workspace, step 2.2): every project-scoped route is
 * registered once and mounted under BOTH the legacy unprefixed `/api/v1/<path>`
 * (bound to the boot project — the protected surface) and
 * `/api/v1/p/:projectId/<path>`, where `default` and the boot project's own id
 * resolve to the same boot context. The suite iterates the route manifest
 * exported by server.ts (derived from the app's actual registrations, so it
 * can never drift) and asserts the three spellings answer byte-identically —
 * plus the scoped-only failure modes: unknown/invalid id → 404, a registered
 * project whose folder is gone → 409.
 */

/** The three spellings of one project route that must answer identically. */
const spellings = (bootId: string, path: string): [string, string, string] => [
  `/api/v1${path}`,
  `/api/v1/p/${bootId}${path}`,
  `/api/v1/p/default${path}`,
];

describe('project-route alias parity (unprefixed vs /api/v1/p/<boot> vs /api/v1/p/default)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;
  let bootId: string;
  let runId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-parity-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-parity-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-parity-other-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_SINGLE_PROJECT;
    // #801: automations are opt-in, and this suite compares the REAL answers of every mirrored
    // route. Left off, the whole `/automations*` family would answer an identical 409 under all
    // three spellings — parity would pass while testing nothing about those routes.
    process.env.CEZ_AUTOMATIONS = '1';
    // Deterministic on any machine: no network, no real agent CLIs.
    process.env.CEZ_DRY_RUN = '1';
    // `skillsRepos: []` disables team skills — no background clone can warm a
    // cache between the first and third spelling of the /skills sweep.
    for (const root of [repoRoot, otherRoot]) {
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
      writeFileSync(join(root, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    runId = store.createRun({
      title: 'parity',
      workflow: 'quick-task',
      task: 'parity',
      steps: [],
    }).id;
    contexts = new ProjectContexts({ listProjects });
    bootId = (await registerProject(repoRoot)).id;
    app = createApp({
      repoRoot,
      store,
      // Only routes that never reach the manager are exercised, plus
      // `isActive` guards on 404-paths — a stub keeps the suite hermetic.
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** Substitute representative values for a manifest path's params. */
  const fillParams = (path: string): string =>
    path
      .replace(':id', runId)
      .replace(':groupId', 'no-such-group')
      .replace(':sha', 'deadbeef')
      .replace(':file', 'shot.png')
      .replace(':kind', 'issue')
      .replace(':number', '7')
      .replace(':name', 'no-such-workflow');

  interface Answer {
    url: string;
    status: number;
    contentType: string | null;
    body: string;
  }

  const answer = async (url: string, init?: RequestInit): Promise<Answer> => {
    const res = await apiRequest(app, url, init);
    return {
      url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: await res.text(),
    };
  };

  /** Body normalizer for routes whose DRY-RUN mock stamps `new Date()` per
   *  request (`/github*` — two back-to-back unprefixed calls differ by a
   *  millisecond too, so this is route-inherent, not alias drift). */
  const stripTimestamps = (body: string): string => body.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<ts>');

  /** Assert the three spellings of `path` answer byte-identically. Requests
   *  run sequentially so per-route caches can never race the comparison. */
  const expectParity = async (path: string, init?: () => RequestInit | undefined): Promise<void> => {
    const normalize = path.startsWith('/github') ? stripTimestamps : (body: string): string => body;
    const [a, b, c] = spellings(bootId, path);
    const unprefixed = await answer(a, init?.());
    const scoped = await answer(b, init?.());
    const aliased = await answer(c, init?.());
    // Compare against the legacy spelling — THE protected surface.
    for (const other of [scoped, aliased]) {
      expect(other.status, `${other.url} vs ${unprefixed.url}`).toBe(unprefixed.status);
      expect(other.contentType, other.url).toBe(unprefixed.contentType);
      expect(normalize(other.body), other.url).toBe(normalize(unprefixed.body));
    }
  };

  it('exports a manifest that covers the whole project-route table', () => {
    const manifest = projectRouteManifest(app);
    const keys = new Set(manifest.map((r) => `${r.method} ${r.path}`));
    // The full table (53 routes at step 2.2) — a floor, not an exact count, so
    // additive routes never break this suite.
    expect(manifest.length).toBeGreaterThanOrEqual(50);
    for (const expected of [
      'GET /launch-key',
      'GET /events',
      'GET /runs/:id/events',
      'GET /runs/:id/history',
      'GET /runs/:id/history-context',
      'POST /runs',
      'POST /runs/archive-finished',
      'PUT /ui-state',
      'PUT /config',
      'GET /agent-config',
      'GET /agent-config/:id',
      'PUT /agent-config/:id',
      'DELETE /runs/:id',
      'PATCH /runs/:id',
      'POST /todos/:id/start',
      'GET /repo/commit/:sha',
    ]) {
      expect(keys, expected).toContain(expected);
    }
    // Workspace-level routes must NOT be mirrored under /api/v1/p/. Agent accounts belong here
    // for the same reason the registry does: an account describes the person and the machine,
    // and a project-scoped spelling would be a second surface to protect with no consumer.
    for (const workspaceOnly of [
      'GET /health',
      'GET /projects',
      'POST /projects',
      'GET /fs/browse',
      'GET /workspace/runs-index',
      'GET /workspace/agent-profiles',
      'POST /workspace/agent-profiles',
      'PATCH /workspace/agent-profiles/:id',
      'DELETE /workspace/agent-profiles/:id',
      'PUT /workspace/agent-profiles/selection',
      'GET /workspace/agent-profiles/:id/details',
      'GET /workspace/agent-profiles/:id/status',
      'POST /workspace/agent-profiles/:id/open',
    ]) {
      expect(keys, workspaceOnly).not.toContain(workspaceOnly);
    }
  });

  it('answers every GET route byte-identically across the three spellings', async () => {
    const manifest = projectRouteManifest(app);
    const gets = manifest.filter((r: ProjectRouteInfo) => r.method === 'GET' && !r.path.endsWith('/events'));
    expect(gets.length).toBeGreaterThanOrEqual(20);
    for (const route of gets) {
      await expectParity(fillParams(route.path));
    }
  });

  it('keeps mutating-route rejections byte-identical (targeted non-GET cases)', async () => {
    const json =
      (method: string, body: unknown): (() => RequestInit) =>
      () => ({
        method,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    // 400: invalid bodies never mutate, so parity can hit them repeatedly.
    await expectParity('/runs', json('POST', {}));
    await expectParity('/ui-state', json('PUT', 'nonsense'));
    await expectParity('/config', json('PUT', { maxParallel: 99 }));
    await expectParity('/agent-config/no-such-file', json('PUT', { content: '{}', version: null }));
    await expectParity('/workflows/parse', json('POST', { yaml: '' }));
    // 404: unknown ids.
    await expectParity('/runs/no-such-run/archive', json('POST', {}));
    await expectParity('/runs/no-such-run', json('PATCH', { title: 't' }));
    await expectParity('/workflows/no-such-workflow', () => ({
      method: 'DELETE',
    }));
    await expectParity('/groups/no-such-group/pick', json('POST', { runId: 'x' }));
    // 409: the follow-up inbox is off (CEZ_FOLLOWUPS unset).
    await expectParity('/todos/t1/start', json('POST', {}));
    // 200 non-GET without observable side effects (no worktrees exist).
    await expectParity('/worktrees/reclaim', json('POST', {}));
  });

  /** Read one SSE response until its first ping, then hang up. */
  const sseHead = async (url: string): Promise<Answer> => {
    const res = await apiRequest(app, url);
    let body = '';
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 5_000;
      while (!body.includes('event: ping') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
    }
    // Everything up to the first keep-alive ping — the deterministic prefix.
    return {
      url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: body.slice(0, body.indexOf('event: ping')),
    };
  };

  it('SSE: all three spellings of /events connect and open identically', async () => {
    const [a, b, c] = spellings(bootId, '/events');
    const [unprefixed, scoped, aliased] = await Promise.all([sseHead(a), sseHead(b), sseHead(c)]);
    for (const stream of [unprefixed, scoped, aliased]) {
      expect(stream.status, stream.url).toBe(200);
      expect(stream.contentType, stream.url).toContain('text/event-stream');
    }
    // The global stream's first frame is the keep-alive ping — nothing may
    // precede it on any spelling.
    for (const other of [scoped, aliased]) {
      expect(other.body, other.url).toBe(unprefixed.body);
    }
  });

  it('SSE: /runs/:id/events replays the same run frame on every spelling', async () => {
    const [a, b, c] = spellings(bootId, `/runs/${runId}/events`);
    const [unprefixed, scoped, aliased] = await Promise.all([sseHead(a), sseHead(b), sseHead(c)]);
    for (const stream of [unprefixed, scoped, aliased]) {
      expect(stream.status, stream.url).toBe(200);
      expect(stream.contentType, stream.url).toContain('text/event-stream');
      // Replay ends with the current run record before the ping loop starts.
      expect(stream.body, stream.url).toContain('event: run');
      expect(stream.body, stream.url).toContain(runId);
    }
    for (const other of [scoped, aliased]) {
      expect(other.body, other.url).toBe(unprefixed.body);
    }
  });

  it('unknown and malformed project ids answer 404 {error}', async () => {
    for (const url of ['/api/v1/p/no-such-project/runs', '/api/v1/p/no-such-project/events']) {
      const res = await apiRequest(app, url);
      expect(res.status, url).toBe(404);
      expect(await res.json()).toEqual({
        error: 'unknown project: no-such-project',
      });
    }
    // Shape violations (uppercase, underscore) fail the zod gate before any
    // registry lookup — still a 404, never a 500 or a path touch.
    const malformed = await apiRequest(app, '/api/v1/p/Bad_Id/runs');
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({
      error: 'unknown project: Bad_Id',
    });
  });

  it('a registered project whose folder is gone answers 409 {error}', async () => {
    const other = await registerProject(otherRoot);
    rmSync(otherRoot, { recursive: true, force: true });
    clearProjectProbeCache(); // drop the status-probe TTL so the loss is seen
    const res = await apiRequest(app, `/api/v1/p/${other.id}/runs`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `project folder not found: ${other.id}`,
    });
  });

  it('a non-boot project builds lazily and answers with its own state', async () => {
    const other = await registerProject(otherRoot);
    expect(contexts.peek(other.id)).toBeUndefined(); // nothing until first touch
    const runs = await apiRequest(app, `/api/v1/p/${other.id}/runs`);
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]); // its own (empty) store, not boot's
    expect(contexts.peek(other.id)).toBeDefined();
    // Its launch key is its own — never the boot project's secret.
    const bootKey = (
      (await (await apiRequest(app, '/api/v1/launch-key')).json()) as {
        key: string;
      }
    ).key;
    const otherKey = (
      (await (await apiRequest(app, `/api/v1/p/${other.id}/launch-key`)).json()) as {
        key: string;
      }
    ).key;
    expect(otherKey).not.toBe(bootKey);
  });

  it('agent config resolves repo-local files from the selected project only', async () => {
    const other = await registerProject(otherRoot);
    mkdirSync(join(repoRoot, '.claude'), { recursive: true });
    mkdirSync(join(otherRoot, '.claude'), { recursive: true });
    writeFileSync(join(repoRoot, '.claude', 'settings.json'), '{"project":"boot"}', 'utf8');
    writeFileSync(join(otherRoot, '.claude', 'settings.json'), '{"project":"other"}', 'utf8');

    const boot = await apiRequest(app, '/api/v1/agent-config/claude.project.settings');
    const scoped = await apiRequest(app, `/api/v1/p/${other.id}/agent-config/claude.project.settings`);
    expect((await boot.json()) as { content: string }).toMatchObject({
      content: '{"project":"boot"}',
    });
    expect((await scoped.json()) as { content: string }).toMatchObject({
      content: '{"project":"other"}',
    });

    const current = (await (
      await apiRequest(app, `/api/v1/p/${other.id}/agent-config/claude.project.settings`)
    ).json()) as { version: string };
    const updated = await apiRequest(app, `/api/v1/p/${other.id}/agent-config/claude.project.settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '{"project":"updated"}',
        version: current.version,
      }),
    });
    expect(updated.status).toBe(200);
    expect(
      (await (await apiRequest(app, '/api/v1/agent-config/claude.project.settings')).json()) as { content: string },
    ).toMatchObject({ content: '{"project":"boot"}' });
  });
});

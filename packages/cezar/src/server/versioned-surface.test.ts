import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The versioned surface is the ONLY surface (spec 2026-07-23-independent-server-web-packages).
 *
 * The service used to answer on an unversioned `/api/*` too, and this file used to assert the
 * two spellings were byte-identical twins. That surface is gone: everything lives under
 * `/api/v1`, which is what `AppType` covers and what the typed client describes.
 *
 * What is worth guarding now is the opposite of the old claim — that nothing has quietly
 * reappeared outside the version prefix.
 */
/** The versioned prefix, spelled once here so the guards below cannot drift from server.ts. */
const V1 = '/api/v1';

describe('the versioned API surface', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: ReturnType<typeof createApp>;
  let bootId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-v1-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-v1-boot-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    // `skillsRepos: []` keeps the workflow catalog hermetic — no background clone can warm a
    // cache between the legacy request and the versioned one.
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    bootId = (await registerProject(repoRoot)).id;
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const answer = async (path: string): Promise<{ status: number; body: string }> => {
    const res = await apiRequest(app, path);
    return { status: res.status, body: await res.text() };
  };

  it('rejects an unknown project', async () => {
    expect((await answer('/api/v1/p/nope/agent-config')).status).toBe(404);
  });

  it('serves health cross-origin — the discovery endpoint', async () => {
    // The deliberate CORS exception (spec 011): the one route a cross-origin caller may read,
    // because it is how anything discovers a running cockpit and what it speaks.
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  /**
   * The guard that replaces the old legacy-vs-versioned comparison.
   *
   * With one surface there is nothing to compare, so what matters is that it stayed one: every
   * route Hono knows about must sit under the version prefix. A route added as a loose
   * `app.get('/api/x')` would answer, would be invisible to `AppType` and the typed client, and
   * would quietly recreate the two-surface problem this removed.
   */
  it('serves no route outside the version prefix', () => {
    const stray = app.routes
      .filter((route) => route.method !== 'ALL')
      .filter((route) => route.path.startsWith('/api/') && !route.path.startsWith(`${V1}/`))
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(
      stray,
      'These routes sit outside `/api/v1`. Every route belongs to a chained family mounted ' +
        'into the versioned table (see the assembly at the end of createApp) — an unversioned ' +
        'route is unreachable by the typed client and reintroduces a second public surface.',
    ).toEqual([]);
  });

  it('finds a non-trivial number of versioned routes — guards against a vacuous pass', () => {
    // Without this, a filter that stopped matching would make the guard above pass by finding
    // nothing anywhere, which is exactly the failure mode a drift guard must not have.
    const versioned = app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith(`${V1}/`));
    expect(versioned.length).toBeGreaterThan(70);
  });
});

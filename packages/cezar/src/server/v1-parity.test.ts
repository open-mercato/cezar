import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.js';
import { ProjectContexts } from './project-context.js';
import { apiRequest } from './loopback-request.testkit.js';
import { createApp } from './server.js';

/**
 * Legacy ↔ versioned parity for the chained families (spec
 * 2026-07-23-independent-server-web-packages).
 *
 * `/api/v1/*` exists so Hono's RPC inference — and with it the typed client — has a surface to
 * describe: it is the same handlers, registered once through a chained builder and mounted a
 * second time under the version prefix. This suite is what makes "same handlers" a fact rather
 * than a claim: every chained route is requested under BOTH spellings (and, for the
 * project-scoped ones, under the scoped form of each) and the answers must be identical.
 *
 * When v1 is deliberately allowed to diverge from the frozen legacy surface, the diverging
 * route comes OUT of the table below and gets its own test saying what changed and why —
 * silently loosening this suite would leave the fold in `bc-route-inventory.test.ts` (which
 * maps `/api/v1/x` onto `/api/x`) lying about the inventory.
 */
/** The versioned prefix, spelled once here so the guards below cannot drift from server.ts. */
const V1 = '/api/v1';

describe('/api/v1 parity with the legacy surface', () => {
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

  /**
   * Workspace-level: one legacy spelling, one versioned.
   *
   * The generous timeout is about `/api/health` specifically: the first read computes a fresh
   * snapshot, which shells out to detect the installed agent CLIs and read git state. That is
   * seconds of real work on a busy machine, and it is the endpoint's actual behavior — the
   * second read comes off the TTL cache, which is also what makes the two answers comparable
   * byte-for-byte rather than two independent probes.
   */
  it.each(['/health'])(
    'answers %s identically under /api and /api/v1',
    async (path) => {
      const legacy = await answer(`/api${path}`);
      expect(legacy.status).toBe(200);
      expect(await answer(`/api/v1${path}`)).toEqual(legacy);
    },
    30_000,
  );

  /** Project-scoped: four spellings — unscoped and scoped, under each version prefix. */
  it.each(['/agent-config', '/workflows'])(
    'answers %s identically across all four spellings',
    async (path) => {
      const legacy = await answer(`/api${path}`);
      expect(legacy.status).toBe(200);
      expect(await answer(`/api/p/${bootId}${path}`)).toEqual(legacy);
      expect(await answer(`/api/v1${path}`)).toEqual(legacy);
      expect(await answer(`/api/v1/p/${bootId}${path}`)).toEqual(legacy);
      expect(await answer(`/api/v1/p/default${path}`)).toEqual(legacy);
    },
  );

  it('resolves an unknown project the same way under the versioned prefix', async () => {
    const legacy = await answer('/api/p/nope/agent-config');
    expect(legacy.status).toBe(404);
    expect(await answer('/api/v1/p/nope/agent-config')).toEqual(legacy);
  });

  it('serves the versioned health endpoint cross-origin, like the legacy one', async () => {
    // `/api/health` is the deliberate CORS exception (spec 011) the bookmarklets discover
    // cockpits with. Its versioned twin has to carry the same header, or a bookmarklet moved
    // onto v1 would silently stop finding anything.
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  /**
   * The completeness guard, and the reason the per-route cases above can stay a short list.
   *
   * Every family is chained now, so the versioned surface is no longer opt-in per family — it
   * is supposed to mirror the legacy one exactly. This walks the built app's own route table
   * and demands a `/api/v1` twin for every `/api` route, which is what catches the realistic
   * regression: someone adds a route with a loose `app.get('/api/…')` statement (the shape 77
   * of these used to have) and it silently never reaches v1, `AppType`, or the typed client.
   *
   * It compares the table rather than making requests, so it stays fast and needs no fixtures.
   */
  it('gives every legacy /api route a versioned twin', () => {
    const routes = app.routes.filter((route) => route.method !== 'ALL');
    const spellings = new Set(routes.map((route) => `${route.method} ${route.path}`));

    const missing = routes
      .filter((route) => route.path.startsWith('/api/'))
      // Skip the versioned side itself, and the project-scoped mirrors — `route-parity.test.ts`
      // owns those, and each one's unscoped spelling is checked here anyway.
      .filter((route) => !route.path.startsWith(`${V1}/`) && !route.path.startsWith('/api/p/'))
      .map((route) => ({ route, twin: `${route.method} ${V1}${route.path.slice('/api'.length)}` }))
      .filter(({ twin }) => !spellings.has(twin))
      .map(({ route }) => `${route.method} ${route.path}`)
      .sort();

    expect(
      missing,
      'These routes exist under /api but have no /api/v1 twin. A route registered as a loose ' +
        'statement never reaches the versioned surface — chain it into a family and mount that ' +
        'family into both tables (see the assembly block at the end of createApp).',
    ).toEqual([]);
  });

  it('finds a non-trivial number of routes — guards against a vacuous pass', () => {
    // Without this, a filter that stopped matching would make the guard above pass by comparing
    // two empty sets, which is exactly the failure mode a drift guard must not have.
    const versioned = app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith(`${V1}/`));
    expect(versioned.length).toBeGreaterThan(70);
  });
});

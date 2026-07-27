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

  it('leaves an unchained family out of the versioned surface', async () => {
    // Not an accident to be fixed by loosening the test: a family is reachable under `/api/v1`
    // only once it has been chained, which is what makes it part of the typed contract. Until
    // then it stays legacy-only, and this asserts the boundary is real.
    expect((await answer('/api/config')).status).toBe(200);
    expect((await answer('/api/v1/config')).status).toBe(404);
  });
});

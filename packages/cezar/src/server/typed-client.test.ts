import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { createCezarClient } from '@open-mercato/cezar-api-client';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.js';
import { ProjectContexts } from './project-context.js';
import type { AppType } from './app-type.js';
import { createApp } from './server.js';

/**
 * The typed client, end to end (spec 2026-07-23-independent-server-web-packages, Phase 1).
 *
 * This is the test the hand-written mirror (`web/app/src/api/types.ts`) and its drift guard
 * exist to replace. It proves the two halves of the claim "the routes ARE the contract":
 *
 *   1. RUNTIME — a client built from `AppType` reaches the real handlers and gets the real
 *      answers. The client's `fetch` is wired straight into the app, so no port is opened and
 *      nothing is stubbed: the response comes out of the same code a browser would hit.
 *   2. COMPILE TIME — the response type is inferred from the handler's `c.json(...)`, not
 *      declared here, and a path the service does not serve is a type error.
 *
 * It lives on the server side because that is where `AppType` is local. When the packaging
 * settles (see the spec's open question about the server becoming its own workspace package),
 * a consumer-side copy of this test belongs wherever the type edge lands.
 */
describe('createCezarClient<AppType>', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createCezarClient<AppType>>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-typed-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-typed-boot-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    await registerProject(repoRoot);
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
    client = createCezarClient<AppType>({
      // Any absolute origin will do — the custom fetch below never leaves the process. The
      // `host` header is what the request-origin guard (#426) checks, and it has to look like
      // the loopback deployment a real cockpit is.
      baseUrl: 'http://127.0.0.1:4321',
      fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        headers.set('host', '127.0.0.1:4321');
        return app.request(String(input), { ...init, headers });
      },
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

  // The generous timeout is `/api/health`'s: a cold read shells out to detect the installed
  // agent CLIs and read git state, which is seconds of real work on a busy machine.
  it(
    'reaches a workspace-level route and infers its response',
    async () => {
      const res = await client.api.v1.health.$get();
      expect(res.status).toBe(200);
      const health = await res.json();
      // Inferred from the handler, not declared here. `not.toBeAny` is the load-bearing
      // assertion: an `any` would make every other type check in this file vacuous, which is
      // exactly how a broken contract would look while still passing.
      expectTypeOf(health).not.toBeAny();
      expect(health).toHaveProperty('version');
    },
    30_000,
  );

  it('reaches a project-scoped route under both the unscoped and scoped spellings', async () => {
    const unscoped = await client.api.v1['agent-config'].$get();
    expect(unscoped.status).toBe(200);
    const scoped = await client.api.v1.p[':projectId']['agent-config'].$get({
      param: { projectId: 'default' },
    });
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toEqual(await unscoped.json());
  });

  it('infers a route parameter, so the scoped call cannot forget it', async () => {
    const call = client.api.v1.p[':projectId'].workflows.$get;
    expectTypeOf<Parameters<typeof call>[0]>().toExtend<{ param: { projectId: string } }>();
  });

  it('rejects a path the service does not serve', () => {
    // @ts-expect-error — `/api/v1/nope` is not a route, and the client knows it. The compile
    // error IS the assertion; if the surface ever gains this path, this line stops erroring
    // and the suite fails loudly.
    expect(() => client.api.v1.nope.$get).toBeDefined();
  });

  it('does not offer the legacy surface', () => {
    // Only `/api/v1/*` is typed: the legacy paths stay frozen for existing callers
    // (BACKWARD_COMPATIBILITY.md §2) rather than being advertised to new ones.
    // @ts-expect-error — `client.api['agent-config']` is not part of the typed contract.
    expect(() => client.api['agent-config']).toBeDefined();
  });
});

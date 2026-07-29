import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  fsBrowseResponseSchema,
  launchKeyResponseSchema,
  projectsResponseSchema,
  registerProjectResponseSchema,
  removeProjectResponseSchema,
  updateProjectResponseSchema,
} from '@open-mercato/cezar-contract';
import type {
  configResponseSchema,
  openTargetsResponseSchema,
  providerConnectResponseSchema,
  providerStatusResponseSchema,
  runnerModelCatalogResponseSchema,
  setConfigResponseSchema,
  skillsUpdateStateSchema,
  workspaceConfigResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/projects.ts` and `src/contract/workspace.ts` must describe EXACTLY what the
 * project-registry, workspace-settings, provider and catalog routes send — no wider, no narrower.
 *
 * Same guard as `contract-parity.test.ts`, same reasoning: each schema is checked against the
 * ROUTE's own inferred type, in BOTH directions, because one-way assignability is green on real
 * drift. `InferResponseType` reads what the route actually answers, which is why it is the right
 * side of every assertion — a schema compared against a handler it annotates is true by
 * construction and can never fail.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract projects/workspace schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  // ---- the project registry --------------------------------------------------------------
  type Projects200 = InferResponseType<typeof client.api.v1.projects.$get, 200>;
  type RegisterProject200 = InferResponseType<typeof client.api.v1.projects.$post, 200>;
  type Checkout200 = InferResponseType<typeof client.api.v1.projects.checkout.$post, 200>;
  type UpdateProject200 = InferResponseType<(typeof client.api.v1.projects)[':projectId']['$patch'], 200>;
  type RemoveProject200 = InferResponseType<(typeof client.api.v1.projects)[':projectId']['$delete'], 200>;
  type FsBrowse200 = InferResponseType<typeof client.api.v1.fs.browse.$get, 200>;
  type LaunchKey200 = InferResponseType<(typeof client.api.v1)['launch-key']['$get'], 200>;

  // ---- workspace settings + the per-repo agent knobs ---------------------------------------
  type WorkspaceConfig200 = InferResponseType<typeof client.api.v1.workspace.config.$get, 200>;
  type SetWorkspaceConfig200 = InferResponseType<typeof client.api.v1.workspace.config.$put, 200>;
  type Config200 = InferResponseType<typeof client.api.v1.config.$get, 200>;
  type SetConfig200 = InferResponseType<typeof client.api.v1.config.$put, 200>;

  // ---- skills updates ---------------------------------------------------------------------
  type SkillsUpdate200 = InferResponseType<(typeof client.api.v1.workspace)['skills-update']['$get'], 200>;
  type SkillsUpdateCheck200 = InferResponseType<
    (typeof client.api.v1.workspace)['skills-update']['check']['$post'],
    200
  >;
  type SkillsUpdateApply200 = InferResponseType<
    (typeof client.api.v1.workspace)['skills-update']['apply']['$post'],
    200
  >;

  // ---- providers, models, open targets ----------------------------------------------------
  type ProviderStatus200 = InferResponseType<typeof client.api.v1.providers.status.$get, 200>;
  type ProviderEnabled200 = InferResponseType<
    (typeof client.api.v1.providers)[':provider']['enabled']['$put'],
    200
  >;
  type ProviderRetry200 = InferResponseType<
    (typeof client.api.v1.providers)[':provider']['retry']['$post'],
    200
  >;
  type ProviderConnect200 = InferResponseType<typeof client.api.v1.providers.connect.$post, 200>;
  type Models200 = InferResponseType<typeof client.api.v1.models.$get, 200>;
  type OpenTargets200 = InferResponseType<(typeof client.api.v1)['open-targets']['$get'], 200>;

  type _Checks = [
    // the registry
    Assert<Exact<z.infer<typeof projectsResponseSchema>, Projects200>>,
    Assert<Exact<z.infer<typeof registerProjectResponseSchema>, RegisterProject200>>,
    Assert<Exact<z.infer<typeof registerProjectResponseSchema>, Checkout200>>,
    Assert<Exact<z.infer<typeof updateProjectResponseSchema>, UpdateProject200>>,
    Assert<Exact<z.infer<typeof removeProjectResponseSchema>, RemoveProject200>>,
    Assert<Exact<z.infer<typeof fsBrowseResponseSchema>, FsBrowse200>>,
    Assert<Exact<z.infer<typeof launchKeyResponseSchema>, LaunchKey200>>,
    // workspace settings + prefs
    Assert<Exact<z.infer<typeof workspaceConfigResponseSchema>, WorkspaceConfig200>>,
    Assert<Exact<z.infer<typeof workspaceConfigResponseSchema>, SetWorkspaceConfig200>>,
    // `uiStateSchema` / `workspaceUiStateSchema` are NOT asserted — see KNOWN GAPS below.
    Assert<Exact<z.infer<typeof configResponseSchema>, Config200>>,
    Assert<Exact<z.infer<typeof setConfigResponseSchema>, SetConfig200>>,
    // skills updates
    Assert<Exact<z.infer<typeof skillsUpdateStateSchema>, SkillsUpdate200>>,
    Assert<Exact<z.infer<typeof skillsUpdateStateSchema>, SkillsUpdateCheck200>>,
    Assert<Exact<z.infer<typeof skillsUpdateStateSchema>, SkillsUpdateApply200>>,
    // providers, models, open targets
    Assert<Exact<z.infer<typeof providerStatusResponseSchema>, ProviderStatus200>>,
    Assert<Exact<z.infer<typeof providerStatusResponseSchema>, ProviderEnabled200>>,
    Assert<Exact<z.infer<typeof providerStatusResponseSchema>, ProviderRetry200>>,
    Assert<Exact<z.infer<typeof providerConnectResponseSchema>, ProviderConnect200>>,
    Assert<Exact<z.infer<typeof runnerModelCatalogResponseSchema>, Models200>>,
    Assert<Exact<z.infer<typeof openTargetsResponseSchema>, OpenTargets200>>,
  ];

  /**
   * KNOWN GAPS — deliberately unasserted, not silently passing.
   *
   * The two OPEN GUI-pref bags, `uiStateSchema` (`GET/PUT /ui-state`) and `workspaceUiStateSchema`
   * (`GET/PUT /workspace/ui-state`), are the only response schemas of these two files with no
   * assertion above. Two independent reasons, and the second is the one that matters:
   *
   * 1. THE INDEX SIGNATURE IS UNREPRESENTABLE. `z.looseObject` infers `{ [k: string]: unknown }`
   *    for the open half, and hono's `JSONParsed` maps `unknown` to its own `JSONValue`
   *    (`hono/utils/types`) — whose object member admits `object | symbol | undefined`, none of
   *    which survive `JSON.stringify` and none of which zod can name (contract rule 2: no imports
   *    but `zod`). `z.json()` is the closest zod has, and comparing it against its own
   *    `JSONParsed` image exceeds tsc's instantiation depth (TS2589), so it is not a way out
   *    either. This is the same class of defect `workflowDef` had, and the reason
   *    `projectListEntrySchema` is a CLOSED object rather than a loose one.
   *
   * 2. STRIPPING THE INDEX SIGNATURE WOULD BE VACUOUS, i.e. it would look like proof and be none.
   *    Both GET routes answer `Record<string, unknown>` verbatim (`src/ui-state.ts`'s
   *    `readUiState`, `src/workspace/ui-state.ts`'s `readWorkspaceUiState`), so the route type
   *    names NO key at all; and every key of both schemas is optional, so a comparison with the
   *    index signature removed is `true` for ANY key set — including a schema that invented keys
   *    the server has never heard of. Measured, not assumed. Asserting that would be exactly the
   *    trap the `it()` below guards the comparator against, so it is named here instead.
   *
   * The fix belongs at the source and is a real design decision, not a typing tweak: the read
   * paths would have to answer the PARSED bag (named keys + the unknown remainder as a distinct
   * key) rather than one opaque record, which is a change to the round-trip promise these files
   * make in BACKWARD_COMPATIBILITY.md §3. Until then the two schemas document the keys the
   * server's own request schema names — which is what their doc comments say they do — and
   * nothing here claims to have proven it.
   */
  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});

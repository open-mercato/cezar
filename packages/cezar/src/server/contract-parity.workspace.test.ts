import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import type { JSONParsed, JSONValue } from 'hono/utils/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  agentAccountDetailsResponseSchema,
  agentAccountStatusResponseSchema,
  agentProfileResponseSchema,
  agentProfileSelectionsResponseSchema,
  agentProfilesResponseSchema,
  openAgentAccountFileResponseSchema,
  removeAgentProfileResponseSchema,
} from '@open-mercato/cezar-contract';
import type {
  fsBrowseResponseSchema,
  launchKeyResponseSchema,
  projectsResponseSchema,
  registerProjectResponseSchema,
  removeProjectResponseSchema,
  updateProjectResponseSchema,
} from '@open-mercato/cezar-contract';
import type { runsIndexResponseSchema } from '@open-mercato/cezar-contract';
import type {
  configResponseSchema,
  openProjectInResponseSchema,
  openTargetsResponseSchema,
  providerConnectResponseSchema,
  providerStatusResponseSchema,
  runnerModelCatalogResponseSchema,
  setConfigResponseSchema,
  skillsUpdateStateSchema,
  uiStateSchema,
  workspaceConfigResponseSchema,
  workspaceUiStateSchema,
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

  /**
   * `Exact`, for the two OPEN bags — the only schemas here with a catchall.
   *
   * `c.json(x)` types its route as `JSONParsed<x>` (hono's `context.d.ts`), and for every CLOSED
   * schema in this file that mapping is the identity, which is why `Exact` compares the raw
   * `z.infer` everywhere else. It is not the identity for a catchall: `z.looseObject` infers
   * `[k: string]: unknown`, and `JSONParsed<unknown>` is hono's `JSONValue`. `unknown` is not
   * assignable to `JSONValue`, so the raw comparison reports `schema-is-wider` — truthfully, since
   * `unknown` admits a bigint the wire cannot carry, but about the CATCHALL rather than about any
   * key either side names. Zod cannot spell `JSONValue` (contract rule 2 forbids importing hono):
   * `z.json()` is the closest, and `JSONParsed` of its recursive type is TS2589 — measured, not
   * assumed. So the schema is compared as its own JSON image, which is the value a consumer
   * actually parses.
   *
   * What that still proves, measured against this app type: a named key whose TYPE drifts fails
   * (`runsView: z.number()` → `schema-is-wider`), and a key the schema makes REQUIRED that the
   * route does not send fails (`route-is-wider`). What it cannot prove is an extra OPTIONAL key —
   * but that is not drift here: an open bag round-trips whatever it was PUT (§3), so a key the
   * server has never heard of is a key it may genuinely answer with.
   */
  type ExactOpen<Schema, Route> = Mutual<JSONParsed<Schema>, Route>;

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
  type UiState200 = InferResponseType<(typeof client.api.v1)['ui-state']['$get'], 200>;
  type SetUiState200 = InferResponseType<(typeof client.api.v1)['ui-state']['$put'], 200>;
  type WorkspaceUiState200 = InferResponseType<(typeof client.api.v1.workspace)['ui-state']['$get'], 200>;
  type SetWorkspaceUiState200 = InferResponseType<(typeof client.api.v1.workspace)['ui-state']['$put'], 200>;
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
  type OpenProjectIn200 = InferResponseType<(typeof client.api.v1)['open-in']['$post'], 200>;

  // ---- agent profiles / accounts (spec 2026-07-29-agent-profiles) --------------------------
  type AgentProfiles200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles']['$get'],
    200
  >;
  type CreateAgentProfile201 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles']['$post'],
    201
  >;
  type UpdateAgentProfile200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles'][':id']['$patch'],
    200
  >;
  type RemoveAgentProfile200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles'][':id']['$delete'],
    200
  >;
  type SelectAgentProfile200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles']['selection']['$put'],
    200
  >;
  type AgentAccountDetails200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles'][':id']['details']['$get'],
    200
  >;
  type AgentAccountStatus200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles'][':id']['status']['$get'],
    200
  >;
  type OpenAgentAccountFile200 = InferResponseType<
    (typeof client.api.v1.workspace)['agent-profiles'][':id']['open']['$post'],
    200
  >;

  type RunsIndex200 = InferResponseType<
    (typeof client.api.v1.workspace)['runs-index']['$get'],
    200
  >;

  type _Checks = [
    // the registry
    Assert<Exact<z.infer<typeof projectsResponseSchema>, Projects200>>,
    // the cross-project task index behind ⌘K
    Assert<Exact<z.infer<typeof runsIndexResponseSchema>, RunsIndex200>>,
    Assert<Exact<z.infer<typeof registerProjectResponseSchema>, RegisterProject200>>,
    Assert<Exact<z.infer<typeof registerProjectResponseSchema>, Checkout200>>,
    Assert<Exact<z.infer<typeof updateProjectResponseSchema>, UpdateProject200>>,
    Assert<Exact<z.infer<typeof removeProjectResponseSchema>, RemoveProject200>>,
    Assert<Exact<z.infer<typeof fsBrowseResponseSchema>, FsBrowse200>>,
    Assert<Exact<z.infer<typeof launchKeyResponseSchema>, LaunchKey200>>,
    // workspace settings + prefs
    Assert<Exact<z.infer<typeof workspaceConfigResponseSchema>, WorkspaceConfig200>>,
    Assert<Exact<z.infer<typeof workspaceConfigResponseSchema>, SetWorkspaceConfig200>>,
    // the two open GUI-pref bags — GET and the merged answer the PUT sends back
    Assert<ExactOpen<z.infer<typeof uiStateSchema>, UiState200>>,
    Assert<ExactOpen<z.infer<typeof uiStateSchema>, SetUiState200>>,
    Assert<ExactOpen<z.infer<typeof workspaceUiStateSchema>, WorkspaceUiState200>>,
    Assert<ExactOpen<z.infer<typeof workspaceUiStateSchema>, SetWorkspaceUiState200>>,
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
    Assert<Exact<z.infer<typeof openProjectInResponseSchema>, OpenProjectIn200>>,
    // agent profiles
    Assert<Exact<z.infer<typeof agentProfilesResponseSchema>, AgentProfiles200>>,
    Assert<Exact<z.infer<typeof agentProfileResponseSchema>, CreateAgentProfile201>>,
    Assert<Exact<z.infer<typeof agentProfileResponseSchema>, UpdateAgentProfile200>>,
    Assert<Exact<z.infer<typeof removeAgentProfileResponseSchema>, RemoveAgentProfile200>>,
    Assert<Exact<z.infer<typeof agentProfileSelectionsResponseSchema>, SelectAgentProfile200>>,
    Assert<Exact<z.infer<typeof agentAccountDetailsResponseSchema>, AgentAccountDetails200>>,
    Assert<Exact<z.infer<typeof agentAccountStatusResponseSchema>, AgentAccountStatus200>>,
    Assert<Exact<z.infer<typeof openAgentAccountFileResponseSchema>, OpenAgentAccountFile200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    // And `ExactOpen`, which normalizes ONLY the JSON round trip: an open bag still fails when a
    // key it names disagrees with the route (here `a: number` against the route's `a: string`),
    // and still fails when it makes a key required that the route never sends. (Both pins spell
    // the key as required: a hand-written index signature must cover its own named properties, and
    // `undefined` is not a `JSONValue` — a constraint mapped types like `JSONParsed` do not apply.)
    const openDrift: ExactOpen<
      { a: number; [k: string]: unknown },
      { a: string; [k: string]: JSONValue }
    > = 'schema-is-wider';
    const openRequired: ExactOpen<{ a: string; [k: string]: unknown }, { [k: string]: JSONValue }> =
      'route-is-wider';
    expect([wider, narrower, openDrift, openRequired]).toEqual([
      'schema-is-wider',
      'route-is-wider',
      'schema-is-wider',
      'route-is-wider',
    ]);
  });
});

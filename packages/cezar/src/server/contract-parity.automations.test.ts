import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  automationCheckQueuedResponseSchema,
  automationCheckSchema,
  automationDetailResponseSchema,
  automationLogResponseSchema,
  automationResponseSchema,
  automationRetryResponseSchema,
  automationsResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/automations.ts` must describe EXACTLY what the GitHub-automation routes (#694)
 * send — no wider, no narrower.
 *
 * Same guard as `contract-parity.test.ts`, same reasoning: each schema is checked against the
 * ROUTE's own inferred type, in BOTH directions, because one-way assignability is green on real
 * drift. `InferResponseType` reads what the route actually answers, which is why it is the right
 * side of every assertion — a schema compared against a handler it annotates is true by
 * construction and can never fail. (That is also why the manual-check record keeps its own
 * `ManualCheck` type in `server.ts` instead of being annotated by `automationCheckSchema`.)
 *
 * Three source fixes came out of writing it, each at the handler rather than in the schema:
 *
 *   - `GET /automations` typed `state`, `latestLog` and `scheduler.nextDue` as always-present keys
 *     holding `T | undefined`, which `JSON.stringify` drops from the wire entirely. They are
 *     spread conditionally now, so the key is optional in the type exactly when it is absent on
 *     the wire;
 *   - `scheduler.state` was an object-literal conditional over two string literals, which hono
 *     inferred as `string` — the discriminant erased. Both arms are `as const`;
 *   - the forge availability spread was a union of the cached answer and the fallback literal;
 *     annotating it `ForgeAvailability` makes the route answer one shape.
 *
 * The one thing this cannot see: an EXTRA key. The storage schemas in `src/automations/types.ts`
 * are `.passthrough()` (a definitions/state/log file written by a newer cezar must round-trip
 * through an older one), so the route's own type carries a catchall and a key the contract never
 * named is admitted by it. Named keys — their types, and whether they are required — are checked
 * in full, which is where drift actually happens.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract automation schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  // ---- the project-scoped family ----------------------------------------------------------
  type Automations200 = InferResponseType<typeof client.api.v1.automations.$get, 200>;
  type CreateAutomation201 = InferResponseType<typeof client.api.v1.automations.$post, 201>;
  type Automation200 = InferResponseType<(typeof client.api.v1.automations)[':id']['$get'], 200>;
  type UpdateAutomation200 = InferResponseType<(typeof client.api.v1.automations)[':id']['$put'], 200>;
  type EnableAutomation200 = InferResponseType<
    (typeof client.api.v1.automations)[':id']['enable']['$post'],
    200
  >;
  type PauseAutomation200 = InferResponseType<
    (typeof client.api.v1.automations)[':id']['pause']['$post'],
    200
  >;
  type CheckAutomation202 = InferResponseType<
    (typeof client.api.v1.automations)[':id']['check']['$post'],
    202
  >;
  type AutomationLog200 = InferResponseType<(typeof client.api.v1)['automation-log']['$get'], 200>;
  type RetryReceipt202 = InferResponseType<
    (typeof client.api.v1)['automation-log'][':receiptId']['retry']['$post'],
    202
  >;

  // ---- the workspace-level manual-check read ------------------------------------------------
  type AutomationCheck200 = InferResponseType<
    (typeof client.api.v1)['automation-checks'][':checkId']['$get'],
    200
  >;

  type _Checks = [
    Assert<Exact<z.infer<typeof automationsResponseSchema>, Automations200>>,
    Assert<Exact<z.infer<typeof automationResponseSchema>, CreateAutomation201>>,
    Assert<Exact<z.infer<typeof automationDetailResponseSchema>, Automation200>>,
    Assert<Exact<z.infer<typeof automationResponseSchema>, UpdateAutomation200>>,
    Assert<Exact<z.infer<typeof automationResponseSchema>, EnableAutomation200>>,
    Assert<Exact<z.infer<typeof automationResponseSchema>, PauseAutomation200>>,
    Assert<Exact<z.infer<typeof automationCheckQueuedResponseSchema>, CheckAutomation202>>,
    Assert<Exact<z.infer<typeof automationLogResponseSchema>, AutomationLog200>>,
    Assert<Exact<z.infer<typeof automationRetryResponseSchema>, RetryReceipt202>>,
    Assert<Exact<z.infer<typeof automationCheckSchema>, AutomationCheck200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    // And the two drifts this family actually produced: a key the route only sometimes sends
    // declared as always-present, and a discriminant widened to `string`.
    const optionality: Mutual<{ a: string }, { a?: string }> = 'route-is-wider';
    const discriminant: Mutual<{ state: 'idle' | 'scheduled' }, { state: string }> = 'route-is-wider';
    expect([wider, narrower, optionality, discriminant]).toEqual([
      'schema-is-wider',
      'route-is-wider',
      'route-is-wider',
      'route-is-wider',
    ]);
  });
});

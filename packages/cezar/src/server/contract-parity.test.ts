import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  healthResponseSchema,
  runHistoryContextSchema,
  runHistoryPageSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * The contract schemas must describe EXACTLY what the routes send — no wider, no narrower.
 *
 * A zod schema sitting next to a handler that builds its payload inline is two definitions again,
 * which is the drift `src/contract/` exists to remove. So each schema is checked against the
 * ROUTE's own inferred type, and in BOTH directions:
 *
 *   - schema wider than the route → the cockpit narrows a case the server never sends;
 *   - route wider than the schema → the server sends a case no consumer was told about.
 *
 * One-way assignability would pass on both. That is not hypothetical: measured before this file
 * existed, the hand-written `ApiRun` and `ProjectsResponse` were both WIDER than their routes and
 * every one-directional check was green.
 *
 * Equally important, do NOT compare a schema against a handler the schema itself annotates — that
 * is true by construction and can never fail. `InferResponseType` reads what the route actually
 * answers, which is why it is the right side of every assertion here.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Health200 = InferResponseType<typeof client.api.v1.health.$get, 200>;
  type History200 = InferResponseType<(typeof client.api.v1.runs)[':id']['history']['$get'], 200>;
  type HistoryContext200 = InferResponseType<(typeof client.api.v1.runs)[':id']['history-context']['$get'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof healthResponseSchema>, Health200>>,
    Assert<Exact<z.infer<typeof runHistoryPageSchema>, History200>>,
    Assert<Exact<z.infer<typeof runHistoryContextSchema>, HistoryContext200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});

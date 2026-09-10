import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { dispatchInputSchema, dispatchReportSchema, dispatchResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/dispatch.ts` must describe EXACTLY what the dispatch routes send and
 * accept — no wider, no narrower. Same guard as `contract-parity.automations.test.ts`: each schema
 * is checked against the ROUTE's own inferred type, in BOTH directions, because one-way
 * assignability is green on real drift. Compile-time; `npm run typecheck` enforces it.
 */
describe('src/contract/dispatch.ts matches the dispatch routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Run = (typeof client.api.v1.runs)[':id'];
  type Dispatch201 = InferResponseType<Run['dispatch']['$post'], 201>;
  type Report200 = InferResponseType<Run['report']['$post'], 200>;
  type DispatchBody = InferRequestType<Run['dispatch']['$post']>['json'];
  type ReportBody = InferRequestType<Run['report']['$post']>['json'];

  type _Checks = [
    Assert<Exact<z.infer<typeof dispatchResponseSchema>, Dispatch201>>,
    Assert<Exact<{ ok: true }, Report200>>,
    // The request halves. `z.input`, not `z.infer`: what a CALLER may send is the schema's input
    // side, and the two differ wherever a field carries a default (the report's arrays).
    Assert<Exact<z.input<typeof dispatchInputSchema>, DispatchBody>>,
    Assert<Exact<z.input<typeof dispatchReportSchema>, ReportBody>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    type Wrong = Mutual<{ id: string }, { id: number }>;
    const wrong: Wrong = 'schema-is-wider';
    expect(wrong).toBe('schema-is-wider');
  });
});

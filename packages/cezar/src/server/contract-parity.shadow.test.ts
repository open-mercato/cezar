import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  shadowDiscardResponseSchema,
  shadowLedgerResponseSchema,
  shadowPromoteResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `contract/shadow.ts` must describe EXACTLY what the shadow routes send (spec
 * 2026-10-06-shadow-runs). Same guard as its siblings: both directions, because one-way
 * assignability is green on real drift. Compile-time; `npm run typecheck` enforces it - and the
 * route types only exist here at all because the family is CHAINED into `v1`.
 */
describe('src/contract/shadow.ts matches the shadow routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Shadow = typeof client.api.v1.runs[':id']['shadow'];
  type Intent = Shadow['intents'][':intentId'];

  type Ledger200 = InferResponseType<Shadow['$get'], 200>;
  type Promote200 = InferResponseType<Intent['promote']['$post'], 200>;
  type Discard200 = InferResponseType<Intent['discard']['$post'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof shadowLedgerResponseSchema>, Ledger200>>,
    Assert<Exact<z.infer<typeof shadowPromoteResponseSchema>, Promote200>>,
    Assert<Exact<z.infer<typeof shadowDiscardResponseSchema>, Discard200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});

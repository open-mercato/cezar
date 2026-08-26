import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { remoteControlStatusSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `remoteControlStatusSchema` vs the `/remote-control` family (spec
 * 2026-08-26-remote-control), both directions — same discipline as
 * contract-parity.test.ts (see its header for why one-way assignability is not enough,
 * and why the route handler must NOT be annotated with the schema's type).
 */
describe('remote-control contract matches the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Status = z.infer<typeof remoteControlStatusSchema>;
  type Get200 = InferResponseType<(typeof client.api.v1)['remote-control']['$get'], 200>;
  type Start200 = InferResponseType<(typeof client.api.v1)['remote-control']['start']['$post'], 200>;
  type Stop200 = InferResponseType<(typeof client.api.v1)['remote-control']['stop']['$post'], 200>;

  type _Checks = [
    Assert<Exact<Status, Get200>>,
    Assert<Exact<Status, Start200>>,
    Assert<Exact<Status, Stop200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    expect(wider).toBe('schema-is-wider');
  });
});

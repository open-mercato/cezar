import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { E2eErrorResponse, E2eSetupInput, E2eSetupResponse, E2eStatus } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1.e2e;
const scoped = client.api.v1.p[':projectId'].e2e;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<E2eStatus, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<E2eStatus, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<E2eSetupInput, InferRequestType<typeof unscoped.setup.$post>['json']>>,
  Assert<Mutual<E2eSetupInput, InferRequestType<typeof scoped.setup.$post>['json']>>,
  Assert<Mutual<E2eSetupResponse, InferResponseType<typeof scoped.setup.$post, 201>>>,
  Assert<Mutual<E2eErrorResponse, InferResponseType<typeof scoped.setup.$post, 409>>>,
];
it('pins the e2e setup route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});

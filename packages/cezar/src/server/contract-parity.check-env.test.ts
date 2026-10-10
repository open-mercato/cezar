import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { CheckEnvErrorResponse, CheckEnvNames, CheckEnvParams, CheckEnvValueInput } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1['check-env'];
const scoped = client.api.v1.p[':projectId']['check-env'];
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<CheckEnvNames, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<CheckEnvNames, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<CheckEnvValueInput, InferRequestType<typeof scoped[':name']['$put']>['json']>>,
  Assert<Mutual<CheckEnvParams & { projectId: string }, InferRequestType<typeof scoped[':name']['$put']>['param']>>,
  Assert<Mutual<CheckEnvParams, InferRequestType<typeof unscoped[':name']['$delete']>['param']>>,
  Assert<Mutual<CheckEnvErrorResponse, InferResponseType<typeof unscoped[':name']['$put'], 409>>>,
  Assert<Mutual<CheckEnvErrorResponse, InferResponseType<typeof unscoped[':name']['$delete'], 404>>>,
];
it('pins the check-env route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});

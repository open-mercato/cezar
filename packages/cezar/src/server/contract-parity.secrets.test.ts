import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { SecretsErrorResponse, SecretsList, SecretParams, SecretValueInput } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1.secrets;
const scoped = client.api.v1.p[':projectId'].secrets;
const workspace = client.api.v1.workspace.secrets;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<SecretsList, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<SecretsList, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<SecretsList, InferResponseType<typeof workspace.$get, 200>>>,
  Assert<Mutual<SecretValueInput, InferRequestType<typeof scoped[':name']['$put']>['json']>>,
  Assert<Mutual<SecretValueInput, InferRequestType<typeof workspace[':name']['$put']>['json']>>,
  Assert<Mutual<SecretParams & { projectId: string }, InferRequestType<typeof scoped[':name']['$put']>['param']>>,
  Assert<Mutual<SecretParams, InferRequestType<typeof unscoped[':name']['$delete']>['param']>>,
  Assert<Mutual<SecretParams, InferRequestType<typeof workspace[':name']['$delete']>['param']>>,
  Assert<Mutual<SecretsErrorResponse, InferResponseType<typeof unscoped[':name']['$put'], 409>>>,
  Assert<Mutual<SecretsErrorResponse, InferResponseType<typeof unscoped[':name']['$delete'], 404>>>,
  Assert<Mutual<SecretsErrorResponse, InferResponseType<typeof workspace[':name']['$delete'], 404>>>,
];
it('pins the secrets route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});

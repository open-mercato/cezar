import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { FleetErrorResponse, FleetJob, FleetJobParams, FleetPanel } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const fleet = client.api.v1.workspace.fleet;
const cancel = fleet.jobs[':id'].cancel;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the fleet panel routes send and accept.
type Checks = [
  Assert<Mutual<FleetPanel, InferResponseType<typeof fleet.$get, 200>>>,
  Assert<Mutual<FleetJob, InferResponseType<typeof cancel.$post, 200>>>,
  Assert<Mutual<FleetErrorResponse, InferResponseType<typeof cancel.$post, 404>>>,
  Assert<Mutual<FleetErrorResponse, InferResponseType<typeof cancel.$post, 409>>>,
  Assert<Mutual<FleetJobParams, InferRequestType<typeof cancel.$post>['param']>>,
];
it('pins the fleet panel route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});

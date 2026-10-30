import type { InferRequestType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { ContinueInput, ExecutionAccessMode, StartTodoInput } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

// Check the consuming typed client, not only runtime JSON. Losing a chained route or its
// middleware used to leave fields accepted by the server invisible to the cockpit's client.
it('carries access selection and account discovery through AppType', () => {
  const client = hc<AppType>('http://127.0.0.1');
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  type Assert<T extends true> = T;
  type Start = InferRequestType<typeof client.api.v1.runs.$post>['json'];
  type Continue = InferRequestType<(typeof client.api.v1.runs)[':id']['continue']['$post']>['json'];
  type Inbox = InferRequestType<(typeof client.api.v1.todos)[':id']['start']['$post']>['json'];
  type Models = InferRequestType<typeof client.api.v1.models.$get>['query'];
  type _Checks = [
    Assert<Mutual<Start['accessMode'], ExecutionAccessMode | undefined>>,
    Assert<Mutual<Continue, ContinueInput>>,
    Assert<Mutual<Inbox, StartTodoInput | undefined>>,
    Assert<Mutual<Models['agentProfile'], string | undefined>>,
  ];
  expect(true).toBe(true);
});

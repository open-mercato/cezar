import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  createManagerInputSchema,
  managerActionDecisionInputSchema,
  managerCreateTaskInputSchema,
  managerCreateTaskResponseSchema,
  managerListResponseSchema,
  managerMessagesResponseSchema,
  managerOkResponseSchema,
  managerSendResponseSchema,
  managerProposeActionInputSchema,
  managerProposeActionResponseSchema,
  managerSnapshotSchema,
  managerSummarySchema,
  managerTaskDetailSchema,
  managerTaskMessageInputSchema,
  sendManagerMessageInputSchema,
  updateManagerInputSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/** `packages/contract/src/managers.ts` must describe EXACTLY what the routes send and accept, both
 *  directions (same guard as `contract-parity.dispatch.test.ts`). Enforced by `npm run typecheck`. */
describe('src/contract/managers.ts matches the managers routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;

  type Managers = typeof client.api.v1.workspace.managers;
  type One = Managers[':id'];
  type Ok = z.infer<typeof managerOkResponseSchema>;
  type Body<R extends { json: unknown }> = R['json'];

  type _Checks = [
    Assert<Mutual<z.infer<typeof managerListResponseSchema>, InferResponseType<Managers['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof managerSummarySchema>, InferResponseType<Managers['$post'], 201>>>,
    Assert<Mutual<z.infer<typeof managerSummarySchema>, InferResponseType<One['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof managerSummarySchema>, InferResponseType<One['$patch'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['$delete'], 200>>>,
    Assert<Mutual<z.infer<typeof managerMessagesResponseSchema>, InferResponseType<One['messages']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof managerSendResponseSchema>, InferResponseType<One['messages']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['stop']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['check']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['read']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['actions'][':actionId']['decision']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof managerSnapshotSchema>, InferResponseType<One['snapshot']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof managerTaskDetailSchema>, InferResponseType<One['task']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof managerCreateTaskResponseSchema>, InferResponseType<One['tasks']['$post'], 201>>>,
    Assert<Mutual<Ok, InferResponseType<One['task-message']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof managerProposeActionResponseSchema>, InferResponseType<One['actions']['$post'], 201>>>,
    Assert<Mutual<Ok, InferResponseType<One['jobs'][':jobId']['$delete'], 200>>>,

    Assert<Mutual<z.input<typeof createManagerInputSchema>, Body<InferRequestType<Managers['$post']>>>>,
    Assert<Mutual<z.input<typeof updateManagerInputSchema>, Body<InferRequestType<One['$patch']>>>>,
    Assert<Mutual<z.input<typeof sendManagerMessageInputSchema>, Body<InferRequestType<One['messages']['$post']>>>>,
    Assert<Mutual<z.input<typeof managerActionDecisionInputSchema>, Body<InferRequestType<One['actions'][':actionId']['decision']['$post']>>>>,
    Assert<Mutual<z.input<typeof managerCreateTaskInputSchema>, Body<InferRequestType<One['tasks']['$post']>>>>,
    Assert<Mutual<z.input<typeof managerTaskMessageInputSchema>, Body<InferRequestType<One['task-message']['$post']>>>>,
    Assert<Mutual<z.input<typeof managerProposeActionInputSchema>, Body<InferRequestType<One['actions']['$post']>>>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    type Wrong = Mutual<{ id: string }, { id: number }>;
    const wrong: Wrong = 'schema-is-wider';
    expect(wrong).toBe('schema-is-wider');
  });
});

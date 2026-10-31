import { hc, type InferResponseType } from 'hono/client';
import { expect, it } from 'vitest';
import type { z } from 'zod';
import type { webhookListSchema, webhookSecretResponseSchema, webhookReceiverResponseSchema, webhookDeliveryOperationResponseSchema, webhookOkSchema, webhookHistoryPageSchema, webhookDeliveriesPageSchema, webhookActivityPageSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';
const client = hc<AppType>('http://127.0.0.1');
const routes = client.api.v1.p[':projectId'].webhooks;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-wider') : 'schema-wider';
type Assert<T extends true> = T;
type Checks = [
  Assert<Equal<z.infer<typeof webhookListSchema>, InferResponseType<typeof routes.$get, 200>>>,
  Assert<Equal<z.infer<typeof webhookSecretResponseSchema>, InferResponseType<typeof routes.$post, 201>>>,
  Assert<Equal<z.infer<typeof webhookSecretResponseSchema>, InferResponseType<typeof routes[':id']['rotate-secret']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookReceiverResponseSchema>, InferResponseType<typeof routes[':id']['$patch'], 200>>>,
  Assert<Equal<z.infer<typeof webhookReceiverResponseSchema>, InferResponseType<typeof routes[':id']['activate']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookReceiverResponseSchema>, InferResponseType<typeof routes[':id']['pause']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookReceiverResponseSchema>, InferResponseType<typeof routes[':id']['resume']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookDeliveryOperationResponseSchema>, InferResponseType<typeof routes[':id']['test']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookDeliveryOperationResponseSchema>, InferResponseType<typeof routes.deliveries[':deliveryId']['retry']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookDeliveryOperationResponseSchema>, InferResponseType<typeof routes.deliveries[':deliveryId']['replay']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof webhookOkSchema>, InferResponseType<typeof routes[':id']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof webhookOkSchema>, InferResponseType<typeof routes.notice.acknowledge.$post, 200>>>,
  Assert<Equal<z.infer<typeof webhookHistoryPageSchema>, InferResponseType<typeof routes.history.$get, 200>>>,
  Assert<Equal<z.infer<typeof webhookDeliveriesPageSchema>, InferResponseType<typeof routes[':id']['deliveries']['$get'], 200>>>,
  Assert<Equal<z.infer<typeof webhookActivityPageSchema>, InferResponseType<typeof routes[':id']['activity']['$get'], 200>>>,
  Assert<Equal<InferResponseType<typeof routes.$get, 200>, InferResponseType<typeof client.api.v1.webhooks.$get, 200>>>,
];
it('enforces webhook route/schema equality through the typed chained app', () => {
  const wider: Equal<{ a: string }, { a: string; b: number }> = 'schema-wider';
  const narrower: Equal<{ a: string; b: number }, { a: string }> = 'route-wider';
  expect([wider, narrower]).toEqual(['schema-wider', 'route-wider']);
});

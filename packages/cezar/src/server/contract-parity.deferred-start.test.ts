import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import type { z } from 'zod';
import type { deferredOptionsSchema, deferredPreviewSchema, deferredCreateResponseSchema, deferredCancellationConflictSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';
import { expect, it } from 'vitest';
const client = hc<AppType>('http://127.0.0.1');
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type OptionsParity = Assert<Mutual<z.infer<typeof deferredOptionsSchema>, InferResponseType<(typeof client.api.v1)['deferred-start']['options']['$post'], 200>>>;
type PreviewParity = Assert<Mutual<z.infer<typeof deferredPreviewSchema>, InferResponseType<(typeof client.api.v1)['deferred-start']['preview']['$post'], 200>>>;
type CreateParity = Assert<Mutual<z.infer<typeof deferredCreateResponseSchema>, InferResponseType<(typeof client.api.v1)['deferred-start']['$post'], 201>>>;
type StartedParity = Assert<Mutual<z.infer<typeof deferredCancellationConflictSchema>, InferResponseType<(typeof client.api.v1)['automations'][':id']['$delete'], 409>>>;
it('checks preview and creation response parity in both directions at compile time', () => {
  const proof: [OptionsParity, PreviewParity, CreateParity, StartedParity] = [true, true, true, true];
  expect(proof).toEqual([true, true, true, true]);
});

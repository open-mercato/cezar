import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  scheduledTaskDetailResponseSchema,
  scheduledTaskOccurrencesResponseSchema,
  scheduledTaskPreviewResponseSchema,
  scheduledTaskResponseSchema,
  scheduledTaskRetryResponseSchema,
  scheduledTaskRunNowResponseSchema,
  scheduledTasksResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/scheduled-tasks.ts` must describe EXACTLY what the one-time
 * scheduled-task routes send — no wider, no narrower. Same guard, same reasoning as
 * `contract-parity.automations.test.ts`: each schema is checked against the ROUTE's own inferred
 * type in BOTH directions. Compile-time; `npm run typecheck` enforces it.
 */
describe('src/contract scheduled-task schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type List200 = InferResponseType<typeof client.api.v1['scheduled-tasks']['$get'], 200>;
  type Create201 = InferResponseType<typeof client.api.v1['scheduled-tasks']['$post'], 201>;
  type Detail200 = InferResponseType<(typeof client.api.v1['scheduled-tasks'])[':id']['$get'], 200>;
  type Update200 = InferResponseType<(typeof client.api.v1['scheduled-tasks'])[':id']['$put'], 200>;
  type Pause200 = InferResponseType<(typeof client.api.v1['scheduled-tasks'])[':id']['pause']['$post'], 200>;
  type Resume200 = InferResponseType<(typeof client.api.v1['scheduled-tasks'])[':id']['resume']['$post'], 200>;
  type RunNow202 = InferResponseType<(typeof client.api.v1['scheduled-tasks'])[':id']['run-now']['$post'], 202>;
  type Preview200 = InferResponseType<(typeof client.api.v1['scheduled-tasks'])['preview']['$post'], 200>;
  type Occurrences200 = InferResponseType<typeof client.api.v1['scheduled-task-occurrences']['$get'], 200>;
  type Retry202 = InferResponseType<
    (typeof client.api.v1['scheduled-task-occurrences'])[':occurrenceId']['retry']['$post'],
    202
  >;

  type _Checks = [
    Assert<Exact<z.infer<typeof scheduledTasksResponseSchema>, List200>>,
    Assert<Exact<z.infer<typeof scheduledTaskResponseSchema>, Create201>>,
    Assert<Exact<z.infer<typeof scheduledTaskDetailResponseSchema>, Detail200>>,
    Assert<Exact<z.infer<typeof scheduledTaskResponseSchema>, Update200>>,
    Assert<Exact<z.infer<typeof scheduledTaskResponseSchema>, Pause200>>,
    Assert<Exact<z.infer<typeof scheduledTaskResponseSchema>, Resume200>>,
    Assert<Exact<z.infer<typeof scheduledTaskRunNowResponseSchema>, RunNow202>>,
    Assert<Exact<z.infer<typeof scheduledTaskPreviewResponseSchema>, Preview200>>,
    Assert<Exact<z.infer<typeof scheduledTaskOccurrencesResponseSchema>, Occurrences200>>,
    Assert<Exact<z.infer<typeof scheduledTaskRetryResponseSchema>, Retry202>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    const optionality: Mutual<{ a: string }, { a?: string }> = 'route-is-wider';
    expect([wider, narrower, optionality]).toEqual(['schema-is-wider', 'route-is-wider', 'route-is-wider']);
  });
});

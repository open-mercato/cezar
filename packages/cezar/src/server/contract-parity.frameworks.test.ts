import { hc, type InferResponseType } from 'hono/client';
import type { ExtractSchema } from 'hono/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  cardOkResponseSchema,
  cardRunResponseSchema,
  duplicateFrameworkResponseSchema,
  frameworkDetailResponseSchema,
  frameworksResponseSchema,
  installFrameworkResponseSchema,
  putProjectFrameworkResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/** The `/frameworks` and `/cards` families (spec 2026-11-15-framework-board) agree with the contract, both ways. */
describe('frameworks/cards routes and contract agree in both directions', () => {
  const client = hc<AppType>('http://127.0.0.1');
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;
  type Frameworks = typeof client.api.v1.frameworks;
  type Cards = typeof client.api.v1.cards;
  type Card = Cards[':runId'];
  type _Checks = [
    Assert<Mutual<z.infer<typeof frameworksResponseSchema>, InferResponseType<Frameworks['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof frameworkDetailResponseSchema>, InferResponseType<Frameworks[':id']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof duplicateFrameworkResponseSchema>, InferResponseType<Frameworks[':id']['duplicate']['$post'], 201>>>,
    Assert<Mutual<z.infer<typeof installFrameworkResponseSchema>, InferResponseType<Frameworks[':id']['install']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof putProjectFrameworkResponseSchema>, InferResponseType<typeof client.api.v1.project.framework.$put, 200>>>,
    Assert<Mutual<z.infer<typeof cardRunResponseSchema>, InferResponseType<Cards['$post'], 201>>>,
    Assert<Mutual<z.infer<typeof cardRunResponseSchema>, InferResponseType<Card['$patch'], 200>>>,
    Assert<Mutual<z.infer<typeof cardRunResponseSchema>, InferResponseType<Card['rerun']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof cardOkResponseSchema>, InferResponseType<Card['finish-stage']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof cardOkResponseSchema>, InferResponseType<Card['approve']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof cardOkResponseSchema>, InferResponseType<Cards['recheck']['$post'], 200>>>,
  ];
  type Schema = ExtractSchema<AppType>;
  type HasJson<P extends keyof Schema, M extends PropertyKey> = Schema[P] extends Record<M, { input: { json: unknown } }> ? true : false;
  type HasParam<P extends keyof Schema, M extends PropertyKey> = Schema[P] extends Record<M, { input: { param: unknown } }> ? true : false;
  type _Inputs = [
    Assert<HasJson<'/api/v1/frameworks/:id/duplicate', '$post'>>,
    Assert<HasParam<'/api/v1/frameworks/:id/duplicate', '$post'>>,
    Assert<HasParam<'/api/v1/frameworks/:id', '$get'>>,
    Assert<HasJson<'/api/v1/frameworks/:id/install', '$post'>>,
    Assert<HasParam<'/api/v1/frameworks/:id/install', '$post'>>,
    Assert<HasJson<'/api/v1/project/framework', '$put'>>,
    Assert<HasJson<'/api/v1/cards', '$post'>>,
    Assert<HasJson<'/api/v1/cards/recheck', '$post'>>,
    Assert<HasJson<'/api/v1/cards/:runId', '$patch'>>,
    Assert<HasJson<'/api/v1/cards/:runId/rerun', '$post'>>,
    Assert<HasJson<'/api/v1/cards/:runId/finish-stage', '$post'>>,
    Assert<HasJson<'/api/v1/cards/:runId/approve', '$post'>>,
  ];
  it('pins the compile-time comparator', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    expect(wider).toBe('schema-is-wider');
  });
});

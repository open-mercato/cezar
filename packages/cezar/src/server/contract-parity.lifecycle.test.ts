import { hc, type InferResponseType } from 'hono/client';
import type { z } from 'zod';
import type { ExtractSchema } from 'hono/types';
import { describe, expect, it } from 'vitest';
import type { lifecycleListResponseSchema, lifecycleDetailResponseSchema, lifecycleOperationResponseSchema, lifecycleOutputResponseSchema, lifecyclePreviewResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

describe('lifecycle routes and contract agree in both directions', () => {
  const client = hc<AppType>('http://127.0.0.1');
  type Mutual<A,B> = [A] extends [B] ? [B] extends [A] ? true : 'route-is-wider' : 'schema-is-wider';
  type Assert<T extends true> = T;
  type Routes = typeof client.api.v1['worktree-lifecycle'];
  type Operations = Routes['operations'];
  type Operation = Operations[':operationId'];
  type _Checks = [
    Assert<Mutual<z.infer<typeof lifecycleListResponseSchema>, InferResponseType<Routes['$get'],200>>>,
    Assert<Mutual<z.infer<typeof lifecycleDetailResponseSchema>, InferResponseType<Routes[':worktreeId']['$get'],200>>>,
    Assert<Mutual<z.infer<typeof lifecycleOperationResponseSchema>, InferResponseType<Operations['$post'],202>>>,
    Assert<Mutual<z.infer<typeof lifecycleOperationResponseSchema>, InferResponseType<Operation['$get'],200>>>,
    Assert<Mutual<z.infer<typeof lifecycleOperationResponseSchema>, InferResponseType<Operation['actions']['$post'],202>>>,
    Assert<Mutual<z.infer<typeof lifecycleOutputResponseSchema>, InferResponseType<Operation['output']['$get'],200>>>,
    Assert<Mutual<z.infer<typeof lifecyclePreviewResponseSchema>, InferResponseType<Routes['preview']['$post'],200>>>,
  ];
  type Schema = ExtractSchema<AppType>;
  type _Bodies = [
    Assert<Schema['/api/v1/worktree-lifecycle/operations']['$post']['input'] extends {json: unknown} ? true : false>,
    Assert<Schema['/api/v1/worktree-lifecycle/operations/:operationId/actions']['$post']['input'] extends {json: unknown; param: unknown} ? true : false>,
    Assert<Schema['/api/v1/worktree-lifecycle/preview']['$post']['input'] extends {json: unknown} ? true : false>,
    Assert<Schema['/api/v1/worktree-lifecycle']['$get']['input'] extends {query: unknown} ? true : false>,
  ];
  it('pins the compile-time comparator', () => {
    const wider: Mutual<{a:string},{a:string;b:number}> = 'schema-is-wider';
    expect(wider).toBe('schema-is-wider');
  });
});

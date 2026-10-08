import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { waitCancelResponseSchema, waitDeclareResponseSchema, waitInputSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/waits.ts` must describe EXACTLY what the wait routes send and accept
 * (spec 2026-10-05-cross-task-waits) — no wider, no narrower, both directions, the guard
 * `contract-parity.dispatch.test.ts` applies to its family. The `kind` discriminant in particular
 * must survive hono's inference as a literal, or a consumer can no longer narrow on it.
 * Compile-time; `npm run typecheck` enforces it.
 */
describe('src/contract/waits.ts matches the wait routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;

  type Run = (typeof client.api.v1.runs)[':id'];
  type Declare200 = InferResponseType<Run['waits']['$post'], 200>;
  type Cancel200 = InferResponseType<Run['waits'][':waitId']['$delete'], 200>;
  type DeclareBody = InferRequestType<Run['waits']['$post']>['json'];

  type _Checks = [
    Assert<Mutual<z.infer<typeof waitDeclareResponseSchema>, Declare200>>,
    Assert<Mutual<z.infer<typeof waitCancelResponseSchema>, Cancel200>>,
    Assert<Mutual<z.input<typeof waitInputSchema>, DeclareBody>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    type Wrong = Mutual<{ kind: 'pending' }, { kind: string }>;
    const wrong: Wrong = 'route-is-wider';
    expect(wrong).toBe('route-is-wider');
  });
});

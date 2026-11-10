import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  deleteDraftResponseSchema,
  draftEntrySchema,
  draftImageContentSchema,
  draftImageSchema,
  runDraftsResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `contract/drafts.ts` must describe EXACTLY what the draft routes send (#939).
 *
 * Same guard as its siblings, same reasoning: both directions, because one-way assignability is
 * green on real drift, and `InferResponseType` reads what the ROUTE answers rather than what a
 * handler was annotated with. Compile-time; `npm run typecheck` enforces it.
 */
describe('src/contract/drafts.ts matches the draft routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Drafts = typeof client.api.v1.runs[':id']['drafts'];
  type Surface = Drafts[':surface'];
  type Images = Surface['images'];

  type List200 = InferResponseType<Drafts['$get'], 200>;
  type Put200 = InferResponseType<Surface['$put'], 200>;
  type Delete200 = InferResponseType<Surface['$delete'], 200>;
  type Upload200 = InferResponseType<Images['$post'], 200>;
  type Blob200 = InferResponseType<Images[':imageId']['$get'], 200>;
  type BlobDelete200 = InferResponseType<Images[':imageId']['$delete'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof runDraftsResponseSchema>, List200>>,
    Assert<Exact<z.infer<typeof draftEntrySchema>, Put200>>,
    Assert<Exact<z.infer<typeof draftImageSchema>, Upload200>>,
    Assert<Exact<z.infer<typeof draftImageContentSchema>, Blob200>>,
    Assert<Exact<z.infer<typeof deleteDraftResponseSchema>, Delete200>>,
    Assert<Exact<z.infer<typeof deleteDraftResponseSchema>, BlobDelete200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});

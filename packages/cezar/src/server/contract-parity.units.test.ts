import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  startMissionInputSchema,
  startMissionResponseSchema,
  unitPromptInputSchema,
  unitPromptSchema,
  unitPromptsResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/units.ts` must describe EXACTLY what the units routes send and accept —
 * no wider, no narrower.
 *
 * Same guard as `contract-parity.automations.test.ts`, same reasoning: each schema is checked
 * against the ROUTE's own inferred type, in BOTH directions, because one-way assignability is
 * green on real drift. `InferResponseType` reads what the route actually answers, which is why it
 * is the right side of every assertion — a schema compared against a handler it annotates is true
 * by construction and can never fail.
 *
 * Two things here are easy to get wrong and are pinned deliberately:
 *
 *   - `POST /missions` answers `{id}` from TWO branches (a `legionary` starts a plain run, a
 *     squad/army starts a root unit run). Both must produce the same literal shape, or hono
 *     infers a union the contract cannot describe with one object;
 *   - `PUT` and `DELETE …/units/prompts/:role` answer one `UnitPrompt` entry each, with `source`
 *     pinned `as const` on both. In an object literal a bare `'file'` widens to `string`, which
 *     erases the discriminant the Settings editor's `edited`/`default` badge reads.
 *
 * The REQUEST side is checked too, which the automations parity file does not do: `/missions` is
 * the only route whose body carries the ladder, and a ladder key the server would not accept is
 * a composer that fails at submit rather than at compile.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract/units.ts matches the units routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Prompts = (typeof client.api.v1.units)['prompts'];
  type Prompt = Prompts[':role'];

  type StartMission201 = InferResponseType<typeof client.api.v1.missions.$post, 201>;
  type Prompts200 = InferResponseType<Prompts['$get'], 200>;
  type PromptPut200 = InferResponseType<Prompt['$put'], 200>;
  type PromptDelete200 = InferResponseType<Prompt['$delete'], 200>;

  type StartMissionBody = InferRequestType<typeof client.api.v1.missions.$post>['json'];
  type PromptPutBody = InferRequestType<Prompt['$put']>['json'];

  type _Checks = [
    Assert<Exact<z.infer<typeof startMissionResponseSchema>, StartMission201>>,
    Assert<Exact<z.infer<typeof unitPromptsResponseSchema>, Prompts200>>,
    Assert<Exact<z.infer<typeof unitPromptSchema>, PromptPut200>>,
    Assert<Exact<z.infer<typeof unitPromptSchema>, PromptDelete200>>,
    // The request halves. `z.input`, not `z.infer`: what a CALLER may send is the schema's input
    // side, and the two differ wherever a field carries a transform or a default.
    Assert<Exact<z.input<typeof startMissionInputSchema>, StartMissionBody>>,
    Assert<Exact<z.input<typeof unitPromptInputSchema>, PromptPutBody>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // A guard that can only pass would be worse than none: this pins `Mutual` itself, so a
    // helper that degenerated to `true` for everything fails here.
    type Wrong = Mutual<{ id: string }, { id: number }>;
    const wrong: Wrong = 'schema-is-wider';
    expect(wrong).toBe('schema-is-wider');
  });
});

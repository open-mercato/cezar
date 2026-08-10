import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  apiRunSchema,
  archiveFinishedResponseSchema,
  cancelResponseSchema,
  continueResponseSchema,
  createPrResponseSchema,
  createRunResponseSchema,
  deleteRunResponseSchema,
  editQueuedMessageResponseSchema,
  finishResponseSchema,
  gitCommitResponseSchema,
  gitPushResponseSchema,
  messageResponseSchema,
  openInCliResponseSchema,
  removeQueuedMessageResponseSchema,
  removeWorktreeResponseSchema,
  runCommitsResponseSchema,
  runRecordSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/runs.ts` must describe EXACTLY what the runs routes send — no wider, no narrower.
 *
 * Same guard as `contract-parity.test.ts`, same reasoning: each schema is checked against the
 * ROUTE's own inferred type, in BOTH directions, because one-way assignability is green on real
 * drift. Measured here: the hand-written DTO declared seven mutation flags `boolean` where the
 * route pins them to `true`, `CreatePrResponse.dryRun` optional where the route always sends it,
 * and `MessageResponse` as one object of optional keys where the route answers a three-way union.
 *
 * `InferResponseType` reads what the route actually answers, which is why it is the right side of
 * every assertion — a schema compared against a handler it annotates is true by construction.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract/runs.ts matches the runs routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Runs = typeof client.api.v1.runs;
  type Run = Runs[':id'];

  type RunsList200 = InferResponseType<Runs['$get'], 200>;
  type RunGet200 = InferResponseType<Run['$get'], 200>;
  type RunCreate201 = InferResponseType<Runs['$post'], 201>;
  type RunArchive200 = InferResponseType<Run['archive']['$post'], 200>;
  type RunRead200 = InferResponseType<Run['read']['$post'], 200>;
  type RunUnread200 = InferResponseType<Run['unread']['$post'], 200>;
  type RunPatch200 = InferResponseType<Run['$patch'], 200>;
  type ArchiveFinished200 = InferResponseType<Runs['archive-finished']['$post'], 200>;
  type Cancel200 = InferResponseType<Run['cancel']['$post'], 200>;
  type Message200 = InferResponseType<Run['messages']['$post'], 200>;
  type QueuedPatch200 = InferResponseType<Run['queued-messages'][':msgId']['$patch'], 200>;
  type QueuedDelete200 = InferResponseType<Run['queued-messages'][':msgId']['$delete'], 200>;
  type Finish200 = InferResponseType<Run['finish']['$post'], 200>;
  type Continue200 = InferResponseType<Run['continue']['$post'], 200>;
  type OpenInCli200 = InferResponseType<Run['open-in-cli']['$post'], 200>;
  type Commits200 = InferResponseType<Run['commits']['$get'], 200>;
  type GitCommit200 = InferResponseType<Run['git']['commit']['$post'], 200>;
  type GitPush200 = InferResponseType<Run['git']['push']['$post'], 200>;
  type CreatePr201 = InferResponseType<Run['pr']['$post'], 201>;
  type RemoveWorktree200 = InferResponseType<Run['remove-worktree']['$post'], 200>;
  type DeleteRun200 = InferResponseType<Run['$delete'], 200>;

  type _Checks = [
    // the record, in both of its two forms
    Assert<Exact<z.infer<typeof apiRunSchema>[], RunsList200[number][]>>,
    Assert<Exact<z.infer<typeof apiRunSchema>, RunGet200>>,
    Assert<Exact<z.infer<typeof runRecordSchema>, RunArchive200>>,
    Assert<Exact<z.infer<typeof runRecordSchema>, RunPatch200>>,
    // the read receipt and its inverse (#unread-done-items, #775) — both answer the record, and
    // pinning them here is what stops either drifting into a bespoke payload
    Assert<Exact<z.infer<typeof runRecordSchema>, RunRead200>>,
    Assert<Exact<z.infer<typeof runRecordSchema>, RunUnread200>>,
    // POST /runs answers 201, and its ×1 branch carries no `usage`
    Assert<
      Exact<
        z.infer<typeof createRunResponseSchema>,
        | Extract<RunCreate201, { id: string }>
        | { runs: Extract<RunCreate201, { runs: unknown }>['runs'][number][] }
      >
    >,
    // lifecycle
    Assert<Exact<z.infer<typeof archiveFinishedResponseSchema>, ArchiveFinished200>>,
    Assert<Exact<z.infer<typeof cancelResponseSchema>, Cancel200>>,
    Assert<Exact<z.infer<typeof finishResponseSchema>, Finish200>>,
    Assert<Exact<z.infer<typeof continueResponseSchema>, Continue200>>,
    Assert<Exact<z.infer<typeof deleteRunResponseSchema>, DeleteRun200>>,
    Assert<Exact<z.infer<typeof createPrResponseSchema>, CreatePr201>>,
    // the queued prompt stack (#472)
    Assert<Exact<z.infer<typeof messageResponseSchema>, Message200>>,
    Assert<Exact<z.infer<typeof editQueuedMessageResponseSchema>, QueuedPatch200>>,
    Assert<Exact<z.infer<typeof removeQueuedMessageResponseSchema>, QueuedDelete200>>,
    // artifacts + local handoff
    Assert<Exact<z.infer<typeof openInCliResponseSchema>, OpenInCli200>>,
    Assert<Exact<z.infer<typeof runCommitsResponseSchema>, Commits200>>,
    Assert<Exact<z.infer<typeof gitCommitResponseSchema>, GitCommit200>>,
    Assert<Exact<z.infer<typeof gitPushResponseSchema>, GitPush200>>,
    Assert<Exact<z.infer<typeof removeWorktreeResponseSchema>, RemoveWorktree200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});

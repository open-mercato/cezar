import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  githubChecksDataSchema,
  githubCommentsDataSchema,
  githubDataSchema,
  githubMergeResponseSchema,
  githubPrChangesDataSchema,
  githubPrMergeStateResponseSchema,
  githubRefStatusDataSchema,
} from '@open-mercato/cezar-contract';
import type {
  changesPayloadSchema,
  reclaimWorktreesResponseSchema,
  repoBranchResponseSchema,
  repoCommitPayloadSchema,
  repoResponseSchema,
  worktreeEntrySchema,
  worktreesResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * Same guard as `contract-parity.test.ts`, for the GitHub family and the repo/git shapes.
 *
 * The schemas must describe EXACTLY what the routes send — no wider, no narrower — so each is
 * checked against the ROUTE's own inferred type, in BOTH directions:
 *
 *   - schema wider than the route → the cockpit narrows a case the server never sends;
 *   - route wider than the schema → the server sends a case no consumer was told about.
 *
 * One-way assignability would pass on both, which is why `Mutual` is the comparator. And no
 * schema here annotates the handler it is compared against — `InferResponseType` reads what the
 * route actually answers, which is the only side that can disagree.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract github + repo schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  // ---- github ---------------------------------------------------------------------------
  type Github200 = InferResponseType<typeof client.api.v1.github.$get, 200>;
  type GithubComments200 = InferResponseType<
    (typeof client.api.v1.github.comments)[':kind'][':number']['$get'],
    200
  >;
  type GithubChecks200 = InferResponseType<typeof client.api.v1.github.checks.$get, 200>;
  type GithubRefStatus200 = InferResponseType<(typeof client.api.v1.github)['ref-status']['$get'], 200>;
  type GithubMergeState200 = InferResponseType<
    (typeof client.api.v1.github.prs)[':number']['merge-state']['$get'],
    200
  >;
  type GithubMerge200 = InferResponseType<
    (typeof client.api.v1.github.prs)[':number']['merge']['$post'],
    200
  >;
  type GithubPrChanges200 = InferResponseType<
    (typeof client.api.v1.github.prs)[':number']['changes']['$get'],
    200
  >;

  // ---- repo / git -----------------------------------------------------------------------
  type Repo200 = InferResponseType<typeof client.api.v1.repo.$get, 200>;
  type RepoBranch200 = InferResponseType<typeof client.api.v1.repo.branch.$post, 200>;
  type RepoChanges200 = InferResponseType<typeof client.api.v1.repo.changes.$get, 200>;
  type RunChanges200 = InferResponseType<(typeof client.api.v1.runs)[':id']['changes']['$get'], 200>;
  type RunCommit200 = InferResponseType<
    (typeof client.api.v1.runs)[':id']['commit'][':sha']['$get'],
    200
  >;
  /**
   * `/repo/commit/:sha` answers the legacy TEXT blob without `?structured=1` (`server.ts:3524`,
   * a protected surface), on the same status as the structured JSON. `string` is that branch and
   * nothing else, so it is excluded by name rather than papered over — everything that IS JSON on
   * this route is still compared mutually.
   */
  type RepoCommit200 = Exclude<
    InferResponseType<(typeof client.api.v1.repo.commit)[':sha']['$get'], 200>,
    string
  >;
  /**
   * `?raw=1` serves an image's BYTES with `c.body(…, 200)` (`server.ts:2795`) — same status as
   * the JSON branches. A zod schema cannot describe an `ArrayBuffer`, so that one member is
   * excluded by name; the JSON surface stays mutually checked.
   */
  type RunFiles200 = Exclude<
    InferResponseType<(typeof client.api.v1.runs)[':id']['files']['$get'], 200>,
    ArrayBuffer
  >;

  type Worktrees200 = InferResponseType<typeof client.api.v1.worktrees.$get, 200>;
  type ReclaimWorktrees200 = InferResponseType<typeof client.api.v1.worktrees.reclaim.$post, 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof githubDataSchema>, Github200>>,
    Assert<Exact<z.infer<typeof githubCommentsDataSchema>, GithubComments200>>,
    Assert<Exact<z.infer<typeof githubChecksDataSchema>, GithubChecks200>>,
    Assert<Exact<z.infer<typeof githubRefStatusDataSchema>, GithubRefStatus200>>,
    Assert<Exact<z.infer<typeof githubPrMergeStateResponseSchema>, GithubMergeState200>>,
    Assert<Exact<z.infer<typeof githubMergeResponseSchema>, GithubMerge200>>,
    Assert<Exact<z.infer<typeof githubPrChangesDataSchema>, GithubPrChanges200>>,
    Assert<Exact<z.infer<typeof repoResponseSchema>, Repo200>>,
    Assert<Exact<z.infer<typeof repoBranchResponseSchema>, RepoBranch200>>,
    Assert<Exact<z.infer<typeof changesPayloadSchema>, RepoChanges200>>,
    Assert<Exact<z.infer<typeof changesPayloadSchema>, RunChanges200>>,
    Assert<Exact<z.infer<typeof repoCommitPayloadSchema>, RepoCommit200>>,
    Assert<Exact<z.infer<typeof repoCommitPayloadSchema>, RunCommit200>>,
    Assert<Exact<z.infer<typeof worktreeEntrySchema>, RunFiles200>>,
    Assert<Exact<z.infer<typeof worktreesResponseSchema>, Worktrees200>>,
    Assert<Exact<z.infer<typeof reclaimWorktreesResponseSchema>, ReclaimWorktrees200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});

import { z } from 'zod';

/**
 * The GitHub family of `/api/v1` — the GitHub tab's list, the lazy checks glyphs, the comment
 * thread, and the PR merge/diff routes.
 *
 * Every one of these routes degrades IN THE PAYLOAD rather than by status code: `gh` missing, no
 * remote, offline and "not found" all answer 200 with `available: false` plus a human hint. So
 * the success shape of several of them is a union, and it is modelled here as one — narrowing on
 * `available` is the whole point, and a flattened object would hand the cockpit an optional
 * `reason` it must re-check on the happy path.
 */

/** The single enum a PR row's checks glyph renders. `null` = no CI configured. Module-local: the
 *  name is unprefixed, and nothing outside this family speaks it. */
const checksGlyphSchema = z.enum(['passing', 'failing', 'pending']).nullable();

/**
 * One issue or pull request, flattened for the cockpit (`ForgeItem` server-side).
 * A protected shape — BACKWARD_COMPATIBILITY.md §2 forbids reshaping it.
 */
export const githubItemSchema = z.object({
  kind: z.enum(['issue', 'pr']),
  number: z.number(),
  title: z.string(),
  author: z.string(),
  createdAt: z.string(),
  labels: z.array(z.string()),
  body: z.string(),
  url: z.string(),
  comments: z.number(),
  /** PRs only. */
  isDraft: z.boolean().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  checks: checksGlyphSchema.optional(),
});
export type GithubItem = z.infer<typeof githubItemSchema>;

/**
 * `GET /api/v1/github` — the tab's issue + PR lists.
 *
 * NOT a discriminated union, unlike its siblings: `fetchGithub` always answers the full record and
 * merely flips `available`, so an unavailable payload still carries `issues: []` / `prs: []`.
 */
export const githubDataSchema = z.object({
  available: z.boolean(),
  /** Why it is unavailable (`gh` missing, no remote, offline…). Never an error — a hint. */
  reason: z.string().optional(),
  /** owner/name, when known. */
  repo: z.string().optional(),
  syncedAt: z.string().optional(),
  issues: z.array(githubItemSchema),
  prs: z.array(githubItemSchema),
  /** Repo-wide label name → 6-hex color (no `#`); lets chips tint like GitHub. Additive. */
  labelColors: z.record(z.string(), z.string()).optional(),
});
export type GithubData = z.infer<typeof githubDataSchema>;

/**
 * `GET /api/v1/github/checks?prs=…` (#664) — lazy PR checks glyphs, `number → glyph`. The list
 * call no longer ships `statusCheckRollup`, so a row's glyph is hydrated here for the on-screen
 * rows only. An absent number means "no checks / not found".
 */
export const githubChecksDataSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    checks: z.record(z.number(), checksGlyphSchema),
  }),
  z.object({
    available: z.literal(false),
    reason: z.string(),
  }),
]);
export type GithubChecksData = z.infer<typeof githubChecksDataSchema>;

/**
 * Where a referenced PR or issue STANDS — the vocabulary a task's tracker chip paints.
 *
 * One flat enum rather than a per-kind union, because the chip renders one status and a union
 * would make every consumer narrow on `kind` before it could pick a color. The kinds share no
 * value on purpose: a closed PR (abandoned — red) and a closed issue (`completed` — done, violet)
 * are opposite outcomes wearing the same English word, and collapsing them is how a merged-looking
 * task turns out to have been dropped.
 *
 * PR values: `merged`, `closed` (closed WITHOUT merging), `draft`, `checks-pending`,
 * `changes-requested`, `checks-failing`, `review-required`, `ready`. Issue values: `open`,
 * `completed`, `not-planned`.
 *
 * Which one a PR gets is `derivePrReferenceStatus`'s ranking (server-side, and documented there):
 * it answers "what is this waiting on right now", so it ranks by how FRESH a signal is rather
 * than by how heavy a blocker it is — running checks mean a commit was just pushed, and a
 * requested change the author has already pushed past is not what the PR is waiting on.
 *
 * `ready` is the honest reading of "nothing is blocking it here": open, not a draft, no failing or
 * running checks, and no review the forge is still waiting on. It is NOT a mergeability probe —
 * that is `githubPrMergeStateResponseSchema`, which costs a request per PR; this is one batched
 * query for a whole table.
 */
export const referenceStatusSchema = z.enum([
  'draft',
  'review-required',
  'changes-requested',
  'checks-pending',
  'checks-failing',
  'ready',
  'merged',
  'closed',
  'open',
  'completed',
  'not-planned',
]);
export type ReferenceStatus = z.infer<typeof referenceStatusSchema>;

/**
 * When the client should ask again — milliseconds, or `null` for "nothing in this answer can
 * change; do not schedule anything".
 *
 * The cockpit does not decide this, and that is the point. Whether a status can still move is
 * forge semantics (a merged pull request is merged forever; a closed one can be reopened; a
 * running check finishes in minutes), and those semantics already live server-side, in the same
 * function that decides how long the answer may be cached. Duplicating them in the cockpit meant
 * two tables of constants that had to agree and nothing making them: too eager and the client
 * burns requests the cache can only answer identically, too lazy and a chip goes stale under a
 * cache that would happily have told it otherwise.
 *
 * So the server answers both questions at once — *what is this* and *when could it differ* — and
 * the cockpit's whole refresh policy becomes "ask again when told to".
 */
const recheckAfterMsSchema = z.number().nullable();

/**
 * `GET /api/v1/github/ref-status?prs=…&issues=…` — batched status for the PR/issue chips a task
 * table is painting. The additive sibling of `/github/checks`: same cache-behind-the-route shape,
 * same in-payload degrade, same "absent number = nothing known" rule (an unknown or unreachable
 * number is simply missing from the map, and its chip stays neutral).
 */
/**
 * How many numbers of ONE kind a single `/github/ref-status` request may name — the route 400s
 * past it, and the cockpit caps its batches to match.
 *
 * It lives in the contract because it is one: a client that believed a larger number would send
 * requests the server rejects outright, costing every chip in the batch its status rather than
 * just the tail. Two constants that must agree, in two packages, with nothing making them, is the
 * drift this export exists to prevent.
 */
export const REFERENCE_STATUS_MAX = 100;

export const githubRefStatusDataSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    prs: z.record(z.number(), referenceStatusSchema),
    issues: z.record(z.number(), referenceStatusSchema),
    /**
     * The pull request numbers that do NOT merge cleanly into their base right now.
     *
     * A second list rather than a twelfth status, because a conflict is a different AXIS from the
     * one `referenceStatusSchema` ranks. That enum answers *whose move is it*, and it answers with
     * one word; mergeability is an independent fact that can be true alongside any of them — a PR
     * can be green, approved and conflicting at the same time, and folding the two together would
     * force the cockpit to pick which of two true things to say. Kept apart, it paints a second
     * chip next to the first and says both.
     *
     * It rides the same GraphQL node the statuses come from (`mergeable`), so unlike
     * `githubPrMergeStateResponseSchema` — the full per-PR probe, blockers and all — it costs no
     * extra request for the batch.
     *
     * Optional on the wire, and its absence means *nothing is known about mergeability*, never
     * *no conflicts*: a server from before this field simply omits it. Only OPEN pull requests are
     * ever named — GitHub reports `UNKNOWN` for merged and closed ones, and `UNKNOWN` (which is
     * also what it answers while it is still computing) is never listed.
     */
    conflicts: z.array(z.number()).optional(),
    recheckAfterMs: recheckAfterMsSchema,
  }),
  z.object({
    available: z.literal(false),
    reason: z.string(),
    recheckAfterMs: recheckAfterMsSchema,
  }),
]);
export type GithubRefStatusData = z.infer<typeof githubRefStatusDataSchema>;

/** One comment or PR review summary in an issue/PR thread (#499). */
export const githubCommentSchema = z.object({
  id: z.number(),
  /** Author login, `'?'` fallback when gh omits the user. */
  author: z.string(),
  avatarUrl: z.string().optional(),
  createdAt: z.string(),
  body: z.string(),
  kind: z.enum(['comment', 'review']),
  /** Reviews only — drives the state chip. */
  reviewState: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).optional(),
  url: z.string(),
});
export type GithubComment = z.infer<typeof githubCommentSchema>;

/**
 * The timeline event kinds the thread renders (#525) — an allowlist, so an unknown GitHub event
 * type is dropped server-side rather than reaching the client.
 */
export const githubTimelineEventKindSchema = z.enum([
  'committed',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
  'merged',
  'closed',
  'reopened',
  'head_ref_force_pushed',
  'cross-referenced',
  'renamed',
]);
export type GithubTimelineEventKind = z.infer<typeof githubTimelineEventKindSchema>;

/**
 * One non-comment timeline row (#525). Deliberately a separate shape from `GithubComment` rather
 * than a widened `kind`, which would break the client's narrowing.
 */
export const githubTimelineEventSchema = z.object({
  id: z.string(),
  kind: githubTimelineEventKindSchema,
  /** Login — or the git author name for `committed`, which carries no GitHub actor. */
  actor: z.string(),
  /** Absent for `committed`. */
  avatarUrl: z.string().optional(),
  createdAt: z.string(),
  url: z.string().optional(),
  /** `committed` — full 40-char SHA. */
  sha: z.string().optional(),
  /** `committed` — first line, capped at 120 chars. */
  message: z.string().optional(),
  /** `committed` — **absent** (lookup failed/skipped) and **`null`** (no CI configured) both
   *  render no glyph, but stay distinct values. */
  checks: checksGlyphSchema.optional(),
  label: z.object({ name: z.string(), color: z.string().optional() }).optional(),
  /** `assigned`/`unassigned` login, or the new title for `renamed`. */
  subject: z.string().optional(),
  refNumber: z.number().optional(),
  refTitle: z.string().optional(),
  refIsPr: z.boolean().optional(),
});
export type GithubTimelineEvent = z.infer<typeof githubTimelineEventSchema>;

/**
 * `GET /api/v1/github/comments/:kind/:number` — the full thread. Degrades to
 * `{ available: false, reason }` like the list fetch, never an error.
 */
export const githubCommentsDataSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  /** Chronological, oldest first. */
  comments: z.array(githubCommentSchema),
  /** True when either stream hit its cap, or the timeline fetch stopped short. */
  truncated: z.boolean().optional(),
  /** Timeline events (#525) — additive; absent when the server degraded to the legacy
   *  comments-only fetch. Capped independently of `comments`. */
  events: z.array(githubTimelineEventSchema).optional(),
});
export type GithubCommentsData = z.infer<typeof githubCommentsDataSchema>;

export const githubMergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);
export type GithubMergeMethod = z.infer<typeof githubMergeMethodSchema>;

/** One check row of the merge panel. */
export const githubPrCheckSchema = z.object({
  name: z.string(),
  state: z.enum(['passing', 'failing', 'pending', 'unknown']),
  required: z.boolean().nullable(),
  url: z.string().optional(),
});
export type GithubPrCheck = z.infer<typeof githubPrCheckSchema>;

/** Everything the merge panel needs about one PR. */
export const githubPrMergeStateSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  headRef: z.string(),
  baseRef: z.string(),
  headSha: z.string(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  reviewDecision: z.enum(['approved', 'changes-requested', 'review-required', 'unknown']),
  checks: z.array(githubPrCheckSchema),
  methods: z.array(githubMergeMethodSchema),
  defaultMethod: githubMergeMethodSchema.nullable(),
  eligibility: z.enum(['ready', 'blocked', 'pending', 'unauthorized', 'terminal', 'unknown']),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  canMerge: z.boolean(),
  canOverride: z.boolean(),
});
export type GithubPrMergeState = z.infer<typeof githubPrMergeStateSchema>;

/** `GET /api/v1/github/prs/:number/merge-state` — 200 either way; the reason is the degrade. */
export const githubPrMergeStateResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), mergeState: githubPrMergeStateSchema }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type GithubPrMergeStateResponse = z.infer<typeof githubPrMergeStateResponseSchema>;

/**
 * `POST /api/v1/github/prs/:number/merge` — the 200 branch only. Every refusal (403/404/409/502)
 * is an `ApiError`, so `merged` is pinned to `true` here rather than a boolean to re-check.
 */
export const githubMergeResponseSchema = z.object({
  merged: z.literal(true),
  number: z.number(),
  url: z.string(),
  method: githubMergeMethodSchema,
  mergeCommitSha: z.string().optional(),
});
export type GithubMergeResponse = z.infer<typeof githubMergeResponseSchema>;

/** One changed file of a pull request's diff. */
export const githubPrChangeSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed']),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
  patchUnavailableReason: z.enum(['binary', 'too-large', 'not-provided']).optional(),
  truncated: z.boolean().optional(),
});
export type GithubPrChange = z.infer<typeof githubPrChangeSchema>;

/** `GET /api/v1/github/prs/:number/changes` — bounded, read-only PR file changes. */
export const githubPrChangesDataSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    number: z.number(),
    headSha: z.string(),
    files: z.array(githubPrChangeSchema),
    additions: z.number(),
    deletions: z.number(),
    truncated: z.boolean(),
    /** Present when the payload is complete but partial in some other way (a capped patch). */
    reason: z.string().optional(),
  }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type GithubPrChangesData = z.infer<typeof githubPrChangesDataSchema>;

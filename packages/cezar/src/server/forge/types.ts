import type { RunRecord } from '../../runs/store.js';

/**
 * Forge-driver seam (cockpit-ui redesign spec §"Forge-driver seam"): every
 * code-forge integration (GitHub today, GitLab later) implements `ForgeDriver`.
 * The interface is shaped strictly around what the cockpit already does via
 * `gh` — issue/PR listing for the GitHub tab, draft-PR creation for the review
 * gate, a per-branch PR probe, and web-URL building. Adding a forge = one new
 * driver file behind `resolveForge`, no route or UI changes.
 */

export type ForgeKind = 'github';

/** Availability probe result — mirrors the tab's quiet degradation contract:
 *  no CLI, no remote, offline all land on `available:false` + a human hint. */
export interface ForgeAvailability {
  available: boolean;
  /** Human-readable hint when unavailable (`gh` missing, no remote, offline…). */
  reason?: string;
}

/** One issue or pull request, flattened for the cockpit. `/api/github` serves
 *  exactly this shape (BACKWARD_COMPATIBILITY.md §2 — do not reshape). */
export interface ForgeItem {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author: string;
  createdAt: string;
  labels: string[];
  body: string;
  url: string;
  comments: number;
  /** PRs only. */
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  checks?: 'passing' | 'failing' | 'pending' | null;
}

/** One comment (or PR review summary) in an issue/PR conversation thread (#499). Served by the
 *  new `GET /api/github/comments/:kind/:number` endpoint; additive, no impact on `ForgeItem`. */
export interface ForgeComment {
  id: number;
  /** Author login, `'?'` fallback when gh omits the user. */
  author: string;
  /** https://avatars.githubusercontent.com/…, when known. */
  avatarUrl?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Markdown body, sliced to the same 8 000-char cap as item bodies. */
  body: string;
  /** `review` = a submitted PR review summary; `comment` = a conversation comment. */
  kind: 'comment' | 'review';
  /** For reviews only — drives the state chip. */
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  /** html_url deep link back to the comment/review on GitHub. */
  url: string;
}

/** The timeline event kinds the thread renders (#525). An allowlist, not a denylist: a new
 *  GitHub event type is dropped rather than rendered, so it can never crash or clutter the
 *  thread. `reviewed` is deliberately absent — reviews stay sourced from `/pulls/{n}/reviews`,
 *  which is already normalized and chipped; sourcing both would render each review twice. */
export type ForgeTimelineEventKind =
  | 'committed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'head_ref_force_pushed'
  | 'cross-referenced'
  | 'renamed';

/** One non-comment row in an issue/PR timeline (#525) — a commit, label change, assignment,
 *  merge, force-push, cross-reference or rename. Additive: `ForgeComment` is untouched and its
 *  `kind` deliberately does NOT widen to cover these (widening breaks client narrowing). */
export interface ForgeTimelineEvent {
  /** `evt-${id ?? sha ?? node_id ?? index}`. Prefixed so it cannot collide with the thread's
   *  `${kind}-${id}` comment keys. `sha` sits ahead of `node_id` because `committed` rows carry
   *  both and the SHA is the natural, debuggable identifier — it is also the rollup key. */
  id: string;
  kind: ForgeTimelineEventKind;
  /** Login — or the git author name for `committed`, which carries no GitHub actor. */
  actor: string;
  /** Absent for `committed` (a git author has no avatar). */
  avatarUrl?: string;
  /** ISO-8601. Resolved per kind: `committed` reads `author.date`, everything else
   *  `created_at` — `committed` rows return `created_at: null`, and mapping it naively
   *  string-sorts every commit to the top of the thread. */
  createdAt: string;
  url?: string;
  /** `committed` — full 40-char SHA (the rollup query rejects abbreviated ones). */
  sha?: string;
  /** `committed` — first line of the message, capped at 120 chars. */
  message?: string;
  /** `committed` — rolled-up CI state. **Absent** (query failed or skipped) and **`null`** (no CI
   *  configured) both render no glyph but stay distinct values for diagnosis. */
  checks?: 'passing' | 'failing' | 'pending' | null;
  /** `labeled` / `unlabeled`. */
  label?: { name: string; color?: string };
  /** `assigned`/`unassigned` login, or the new title for `renamed`. */
  subject?: string;
  /** `cross-referenced`. */
  refNumber?: number;
  refTitle?: string;
  refIsPr?: boolean;
}

/** The `GET /api/github/comments/:kind/:number` payload — mirrors the tab's quiet-degrade
 *  contract (`available: false` + a hint, never a 5xx). */
export interface ForgeCommentsData {
  available: boolean;
  /** Human-readable hint when unavailable. */
  reason?: string;
  /** Chronological, oldest first. */
  comments: ForgeComment[];
  /** True when either stream hit its cap, or the timeline fetch stopped short. Means "not
   *  showing you everything" — not specifically "comments were cut". */
  truncated?: boolean;
  /** Timeline events (#525) — additive and optional; absent when the timeline fetch degraded to
   *  the legacy comments-only call. Capped independently of `comments`, which keeps its exact
   *  pre-#525 shape, contents and cap (BACKWARD_COMPATIBILITY.md §2). */
  events?: ForgeTimelineEvent[];
}

export interface ForgeListOptions {
  /** Bypass the driver's short cache. */
  refresh?: boolean;
  /** Max items to fetch (driver-capped). */
  limit?: number;
}

/** Where an existing branch's PR stands — feeds the Create PR → View PR flip. */
export interface ForgePrStatus {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  checks: 'passing' | 'failing' | 'pending' | null;
}

export type ForgeMergeMethod = 'merge' | 'squash' | 'rebase';

export interface ForgePrCheck {
  name: string;
  state: 'passing' | 'failing' | 'pending' | 'unknown';
  required: boolean | null;
  url?: string;
}

export interface ForgePrMergeState {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'unknown';
  checks: ForgePrCheck[];
  methods: ForgeMergeMethod[];
  defaultMethod: ForgeMergeMethod | null;
  eligibility: 'ready' | 'blocked' | 'pending' | 'unauthorized' | 'terminal' | 'unknown';
  blockers: Array<{ code: string; message: string }>;
  canMerge: boolean;
  canOverride: boolean;
}

export type ForgePrMergeStateResult =
  | { available: true; mergeState: ForgePrMergeState }
  | { available: false; reason: string };

export interface ForgeMergeInput {
  method: ForgeMergeMethod;
  expectedHeadSha: string;
  overrideRules?: boolean;
}

export type ForgeMergeResult =
  | {
      merged: true;
      number: number;
      url: string;
      method: ForgeMergeMethod;
      mergeCommitSha?: string;
    }
  | {
      merged: false;
      status: 403 | 404 | 409 | 502;
      error: string;
      code?: string;
      current?: ForgePrMergeState;
    };

export interface ForgePrChange {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  patch?: string;
  patchUnavailableReason?: 'binary' | 'too-large' | 'not-provided';
  truncated?: boolean;
}

export type ForgePrDiffResult =
  | {
      available: true;
      number: number;
      headSha: string;
      files: ForgePrChange[];
      additions: number;
      deletions: number;
      truncated: boolean;
      reason?: string;
    }
  | { available: false; reason: string };
export type ForgeRefKind = 'repo' | 'issue' | 'pr' | 'branch' | 'commit';

export type DraftPrOutcome =
  | { ok: true; url: string; dryRun: boolean }
  | { ok: false; error: string };

export interface DraftPrInput {
  repoRoot: string;
  run: RunRecord;
  /** The task's handoff.md — becomes the PR body (goal + progress skim). */
  handoffText: string;
}

export interface ForgeDriver {
  readonly kind: ForgeKind;
  /** Cheap, cached availability probe. May shell out (used by the GitHub tab). */
  detect(): Promise<ForgeAvailability>;
  /** Non-blocking availability for the health path: cached result, or null while warming — never
   *  shells out on the read (keeps /api/health under the bookmarklet's latency budget). */
  detectCached(): ForgeAvailability | null;
  listIssues(opts?: ForgeListOptions): Promise<ForgeItem[]>;
  listPRs(opts?: ForgeListOptions): Promise<ForgeItem[]>;
  /** Draft-PR creation for the review gate (spec 009). Never throws. */
  createPR(input: DraftPrInput): Promise<DraftPrOutcome>;
  /** The branch's open/merged PR, or null when none (or the forge is down). */
  prStatus(branch: string): Promise<ForgePrStatus | null>;
  prMergeState?(number: number, opts?: { refresh?: boolean }): Promise<ForgePrMergeStateResult>;
  mergePR?(number: number, input: ForgeMergeInput): Promise<ForgeMergeResult>;
  /** Bounded, read-only file changes for a pull request. */
  prDiff?(number: number, opts?: { refresh?: boolean }): Promise<ForgePrDiffResult>;
  /** Web URL for a ref on the forge, or null when the remote isn't parseable. */
  viewUrl(kind: ForgeRefKind, ref: string | number): string | null;
}

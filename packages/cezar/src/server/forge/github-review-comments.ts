import { z } from 'zod';
import type { GithubReviewComment, GithubReviewCommentsData } from '@open-mercato/cezar-contract';

/**
 * A PR's inline (line-anchored) review comments — `pulls/{n}/comments` — normalized for the task
 * Changes tab (spec 2026-07-18-github-comment-threads, follow-up note). The pure half: the zod
 * boundary, the mapping, the resolved-state merge and the dry-run fixture. The `gh` calls and the
 * cache live with the other comment fetches in `github.ts`.
 */

/** Entries kept, oldest first; past it the list is `truncated`. */
export const REVIEW_COMMENT_CAP = 300;
/** Same body cap as thread comments. */
const BODY_CAP = 8_000;
/** The hunk excerpt is context for an outdated comment, not the file: its tail is what matters. */
const HUNK_MAX_LINES = 12;
const HUNK_MAX_CHARS = 2_000;

const ghSide = z.string().nullish();
const ghLine = z.number().int().nullish();

/** One `pulls/{n}/comments` row. Extras are stripped; unknown sides fall back to `new`. */
export const ghReviewCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string(), avatar_url: z.string().nullish() }).nullish(),
  created_at: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
  path: z.string(),
  side: ghSide,
  start_side: ghSide,
  line: ghLine,
  original_line: ghLine,
  start_line: ghLine,
  original_start_line: ghLine,
  position: ghLine,
  in_reply_to_id: z.number().nullish(),
  subject_type: z.string().nullish(),
  diff_hunk: z.string().nullish(),
});

const toSide = (side: string | null | undefined): 'old' | 'new' => (side?.toUpperCase() === 'LEFT' ? 'old' : 'new');
const positive = (n: number | null | undefined): number | undefined => (n != null && n > 0 ? n : undefined);

function capHunk(hunk: string | null | undefined): string | undefined {
  if (!hunk) return undefined;
  const tail = hunk.split('\n').slice(-HUNK_MAX_LINES).join('\n');
  return tail.length > HUNK_MAX_CHARS ? tail.slice(-HUNK_MAX_CHARS) : tail;
}

/**
 * Rows → `GithubReviewComment[]`, oldest first, capped. A row that fails the schema is dropped,
 * not the page. Replies take their root's anchor so the client can thread them by `inReplyTo`.
 *
 * `outdated`: a line comment with no current `line`. A file-level comment never has a line, so it
 * is outdated only when GitHub could not place it on the head at all (`position` null).
 */
export function normalizeReviewComments(
  raw: unknown,
  cap = REVIEW_COMMENT_CAP,
): { comments: GithubReviewComment[]; truncated: boolean } {
  const rows = z.array(z.unknown()).parse(raw).flatMap((row) => {
    const parsed = ghReviewCommentSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const mapped = rows.map((r): GithubReviewComment => {
    const fileLevel = r.subject_type === 'file';
    const line = fileLevel ? undefined : positive(r.line);
    const comment: GithubReviewComment = {
      id: r.id,
      author: r.user?.login ?? '?',
      createdAt: r.created_at,
      body: (r.body ?? '').slice(0, BODY_CAP),
      url: r.html_url,
      path: r.path,
      side: toSide(r.side),
      outdated: fileLevel ? r.position === null : line === undefined,
    };
    if (r.user?.avatar_url) comment.avatarUrl = r.user.avatar_url;
    if (line !== undefined) comment.line = line;
    const originalLine = positive(r.original_line);
    if (originalLine !== undefined) comment.originalLine = originalLine;
    const startLine = positive(r.start_line);
    if (startLine !== undefined && line !== undefined && startLine !== line) {
      comment.startLine = startLine;
      comment.startSide = r.start_side ? toSide(r.start_side) : comment.side;
    }
    const originalStartLine = positive(r.original_start_line);
    if (originalStartLine !== undefined && originalStartLine !== originalLine) comment.originalStartLine = originalStartLine;
    if (r.in_reply_to_id != null) comment.inReplyTo = r.in_reply_to_id;
    if (r.subject_type === 'line' || fileLevel) comment.subjectType = fileLevel ? 'file' : 'line';
    const hunk = capHunk(r.diff_hunk);
    if (hunk) comment.diffHunk = hunk;
    return comment;
  });

  const byId = new Map(mapped.map((c) => [c.id, c]));
  for (const comment of mapped) {
    const root = comment.inReplyTo === undefined ? undefined : byId.get(comment.inReplyTo);
    if (!root) continue;
    comment.path = root.path;
    comment.side = root.side;
    comment.outdated = root.outdated;
    delete comment.line;
    delete comment.startLine;
    delete comment.startSide;
    if (root.line !== undefined) comment.line = root.line;
    if (root.startLine !== undefined) {
      comment.startLine = root.startLine;
      if (root.startSide) comment.startSide = root.startSide;
    }
  }

  const sorted = mapped.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const truncated = sorted.length > cap;
  return { comments: truncated ? sorted.slice(0, cap) : sorted, truncated };
}

/** Threads looked up for resolved state — one GraphQL page; later threads stay unknown. */
export const REVIEW_THREADS_FIRST = 100;

export function reviewThreadsQuery(number: number): string {
  return `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: ${number}) {
      reviewThreads(first: ${REVIEW_THREADS_FIRST}) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } }
    }
  }
}`;
}

const reviewThreadsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              comments: z.object({ nodes: z.array(z.object({ databaseId: z.number().nullish() }).nullable()) }),
            }).nullable(),
          ),
        }),
      }).nullable(),
    }).nullable(),
  }),
});

/** GraphQL `reviewThreads` output → root comment id → resolved. Throws on a malformed answer. */
export function parseResolvedThreads(raw: string): Map<number, boolean> {
  const parsed = reviewThreadsSchema.parse(JSON.parse(raw));
  const out = new Map<number, boolean>();
  for (const node of parsed.data.repository?.pullRequest?.reviewThreads.nodes ?? []) {
    const rootId = node?.comments.nodes[0]?.databaseId;
    if (node && rootId != null) out.set(rootId, node.isResolved);
  }
  return out;
}

/** Marks ROOT comments resolved or not; replies and unknown threads are left without the field. */
export function applyResolved(comments: GithubReviewComment[], resolved: ReadonlyMap<number, boolean>): void {
  for (const comment of comments) {
    if (comment.inReplyTo !== undefined) continue;
    const state = resolved.get(comment.id);
    if (state !== undefined) comment.resolved = state;
  }
}

/**
 * CEZ_DRY_RUN=1 — anchored on `notes.md`, the file the mock agent appends to in every task
 * worktree (`scripts/mock-claude.mjs`), so the Changes tab shows each case offline: a resolved
 * and an open thread with a reply, a range, an old-side comment, an outdated one and one on a
 * file the task never touched.
 */
export function mockGithubReviewComments(): GithubReviewCommentsData {
  const base = Date.now() - 7_200_000;
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const url = (id: number) => `https://github.com/mock/repo/pull/1#discussion_r${id}`;
  const ada = { author: 'ada', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' };
  const lin = { author: 'lin', avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4' };
  const grace = { author: 'grace', avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4' };
  const comments: GithubReviewComment[] = [
    {
      id: 9001, ...ada, createdAt: at(0), url: url(9001), path: 'notes.md', side: 'new', line: 1, originalLine: 1,
      outdated: false, subjectType: 'line', resolved: false,
      body: 'Could this line say **which** run wrote it?\n\n- add the run id\n- keep the timestamp in `ISO` form',
    },
    {
      id: 9002, ...lin, createdAt: at(12), url: url(9002), path: 'notes.md', side: 'new', line: 1, originalLine: 1,
      outdated: false, subjectType: 'line', inReplyTo: 9001,
      body: 'Agreed — the id is already in the handoff file, so it is one lookup.',
    },
    {
      id: 9003, ...grace, createdAt: at(20), url: url(9003), path: 'notes.md', side: 'new', line: 2, originalLine: 2,
      startLine: 1, startSide: 'new', originalStartLine: 1, outdated: false, subjectType: 'line', resolved: true,
      body: 'These two lines could be one list.',
    },
    {
      id: 9004, ...ada, createdAt: at(30), url: url(9004), path: 'notes.md', side: 'old', line: 1, originalLine: 1,
      outdated: false, subjectType: 'line',
      body: 'Why was the old header dropped?',
    },
    {
      id: 9005, ...lin, createdAt: at(40), url: url(9005), path: 'notes.md', side: 'new', originalLine: 3,
      outdated: true, subjectType: 'line',
      diffHunk: '@@ -0,0 +1,3 @@\n+mock notes — first run\n+mock notes — second run\n+mock notes — third run',
      body: 'This line moved in a later push — still worth a look.',
    },
    {
      id: 9006, ...grace, createdAt: at(50), url: url(9006), path: 'src/legacy/config.ts', side: 'new', line: 12,
      originalLine: 12, outdated: false, subjectType: 'line',
      diffHunk: '@@ -10,3 +10,3 @@ export const config = {\n   retries: 3,\n-  timeout: 1000,\n+  timeout: 5000,',
      body: 'A 5 s timeout here hides slow responses; can we keep it at 1 s?',
    },
  ];
  return { available: true, comments };
}

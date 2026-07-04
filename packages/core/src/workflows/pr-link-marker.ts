/**
 * Sticky `cezar:pr-link` comment on an issue — a persistent breadcrumb that
 * records which PR Cezar opened for the issue. Survives across flow runs, so
 *
 *   - a verify step on a *later* run can see "PR #N is already open" and stop
 *     cleanly with NO_ACTION_NEEDED instead of re-running a fix the agent
 *     might hallucinate;
 *   - a review step whose in-memory blackboard lost the PR number can fall
 *     back to the marker;
 *   - an operator skimming the issue thread sees one canonical "Cezar opened
 *     PR #N" line instead of a forest of per-step comments.
 *
 * Schema (one HTML comment + a one-line visible body):
 *
 *   <!-- cezar:pr-link
 *   pr_number: 2050
 *   pr_url: https://github.com/o/r/pull/2050
 *   pr_state: changes-requested
 *   branch: autofix/cezar-issue-1704
 *   opened_at: 2026-05-25T04:01:00Z
 *   last_event_at: 2026-05-25T05:07:22Z
 *   -->
 *   🤖 Cezar opened **[PR #2050](https://github.com/o/r/pull/2050)** for this issue. Status: `changes-requested`.
 *
 * The HTML block is the source of truth — the visible body is regenerated
 * from it on every update. `pr_state` is free-form (we don't enforce a fixed
 * set; the LLM may invent labels like `wip-conflicts` and that's fine).
 */

/** Tag that uniquely identifies the marker comment body. */
export const PR_LINK_MARKER_TAG = 'cezar:pr-link';

const MARKER_OPEN_RE = new RegExp(`<!--\\s*${PR_LINK_MARKER_TAG}\\s*([\\s\\S]*?)-->`, 'i');

/** Coarse classification of `pr_state` for downstream "is this PR still
 *  blocking new work?" decisions. Free-form strings come back as 'other'. */
export type PrLinkActivity = 'active' | 'merged' | 'closed' | 'other';

export interface PrLinkData {
  prNumber: number;
  prUrl: string;
  /** Free-form. Common values: 'draft', 'review', 'changes-requested',
   *  'merged', 'closed', 'wip'. Consumers should match by activity (see
   *  `classifyActivity`) rather than equality. */
  prState: string;
  branch?: string;
  openedAt?: string;
  lastEventAt?: string;
}

/** Classify a free-form `pr_state` into one of four buckets. Defaults to
 *  `other` so a typo doesn't accidentally look "active". */
export function classifyActivity(state: string): PrLinkActivity {
  const s = state.trim().toLowerCase();
  if (s === 'merged') return 'merged';
  if (s === 'closed' || s === 'cancelled' || s === 'canceled') return 'closed';
  if (
    s === 'draft' ||
    s === 'open' ||
    s === 'review' ||
    s === 'changes-requested' ||
    s === 'wip' ||
    s === 'wip-conflicts' ||
    s === 'in-review'
  )
    return 'active';
  return 'other';
}

/** Render a marker comment body. The visible portion is generated from the
 *  same data block so it can't drift out of sync. */
export function formatMarkerComment(data: PrLinkData): string {
  const fields: string[] = [
    `pr_number: ${data.prNumber}`,
    `pr_url: ${data.prUrl}`,
    `pr_state: ${data.prState}`,
  ];
  if (data.branch) fields.push(`branch: ${data.branch}`);
  if (data.openedAt) fields.push(`opened_at: ${data.openedAt}`);
  if (data.lastEventAt) fields.push(`last_event_at: ${data.lastEventAt}`);
  const visible = `🤖 Cezar opened **[PR #${data.prNumber}](${data.prUrl})** for this issue. Status: \`${data.prState}\`.`;
  return `<!-- ${PR_LINK_MARKER_TAG}\n${fields.join('\n')}\n-->\n${visible}`;
}

/** Parse a comment body. Returns null when it is not a marker comment or the
 *  required fields are missing — caller can then ignore it cleanly. */
export function parseMarkerComment(body: string): PrLinkData | null {
  if (!body) return null;
  const open = body.match(MARKER_OPEN_RE);
  if (!open) return null;
  const fields = parseFields(open[1]);
  const prNumber = Number(fields.pr_number);
  const prUrl = fields.pr_url;
  const prState = fields.pr_state;
  if (!Number.isFinite(prNumber) || prNumber <= 0 || !prUrl || !prState) return null;
  return {
    prNumber,
    prUrl,
    prState,
    branch: fields.branch || undefined,
    openedAt: fields.opened_at || undefined,
    lastEventAt: fields.last_event_at || undefined,
  };
}

function parseFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (!m) continue;
    out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** Minimal GitHub surface we need to read & write the marker. */
export interface PrLinkGitHubGateway {
  addComment(issueNumber: number, body: string): Promise<number | void>;
  updateComment(commentId: number, body: string): Promise<void>;
  listIssueCommentsWithIds?(
    issueNumber: number,
  ): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>>;
}

/** Locate the most recent marker comment on the issue, returning its id +
 *  parsed payload. Returns null when no marker exists or `listIssueCommentsWithIds`
 *  is unavailable (graceful fallback — callers can still upsert a fresh
 *  comment via `addComment`, just without sticky-edit semantics). */
export async function findMarkerComment(
  github: PrLinkGitHubGateway,
  issueNumber: number,
): Promise<{ id: number; data: PrLinkData } | null> {
  if (!github.listIssueCommentsWithIds) return null;
  const comments = await github.listIssueCommentsWithIds(issueNumber);
  // Walk newest-last first so a re-created marker wins over a stale one. The
  // API returns chronological order, so a reverse iteration is correct.
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const data = parseMarkerComment(comments[i].body);
    if (data) return { id: comments[i].id, data };
  }
  return null;
}

/** Upsert the marker comment: edit-in-place when one exists, post fresh
 *  otherwise. Preserves `opened_at` from the existing comment so the marker
 *  reflects the original PR creation time across updates. Errors are
 *  rethrown — callers that want fire-and-forget semantics should wrap. */
export async function upsertMarkerComment(
  github: PrLinkGitHubGateway,
  issueNumber: number,
  data: PrLinkData,
): Promise<{ id: number | null; created: boolean }> {
  const existing = await findMarkerComment(github, issueNumber);
  const now = new Date().toISOString();
  const merged: PrLinkData = {
    ...data,
    openedAt: data.openedAt ?? existing?.data.openedAt ?? now,
    lastEventAt: data.lastEventAt ?? now,
  };
  const body = formatMarkerComment(merged);
  if (existing) {
    await github.updateComment(existing.id, body);
    return { id: existing.id, created: false };
  }
  const id = await github.addComment(issueNumber, body);
  return { id: typeof id === 'number' ? id : null, created: true };
}

/** Compact one-line description of a marker for templates / log messages. */
export function describeMarkerForPrompt(data: PrLinkData): string {
  const activity = classifyActivity(data.prState);
  return `PR #${data.prNumber} (${data.prState}, classified ${activity}) at ${data.prUrl}`;
}

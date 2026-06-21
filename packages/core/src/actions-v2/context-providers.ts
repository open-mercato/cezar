/**
 * Shared formatting for the `open-issues` context provider — the open-issue
 * knowledge base the runner injects into the user message for actions that
 * declare `contextRefs: ['open-issues']` (the dedupe half of `auto-triage`).
 *
 * Callers (GUI jobs, the CLI runner) fetch the open issues from their own
 * store and hand the rows here; the section shape stays identical across
 * surfaces so the `dedupe-heuristics` skill can rely on it.
 */

export interface OpenIssueKbEntry {
  number: number;
  title: string;
  /** Short issue summary — a digest summary when available, else a body excerpt. */
  summary?: string | null;
}

const SUMMARY_MAX_CHARS = 300;
const DEFAULT_CAP = 100;

/**
 * Format an open-issue list as a `## Open-issue knowledge base` markdown
 * section — one line per issue (`- #<number> — <title>: <summary>`), summary
 * collapsed to a single line and clipped to ~300 chars, capped at `opts.cap`
 * (default 100) entries with a trailing "…and N more" line when truncated.
 * Returns '' for an empty list (the runner skips empty sections).
 */
export function formatOpenIssuesKb(issues: OpenIssueKbEntry[], opts?: { cap?: number }): string {
  if (issues.length === 0) return '';
  const cap = opts?.cap ?? DEFAULT_CAP;
  const shown = issues.slice(0, cap);
  const lines = shown.map((issue) => {
    const summary = clipSummary(issue.summary);
    return summary
      ? `- #${issue.number} — ${issue.title}: ${summary}`
      : `- #${issue.number} — ${issue.title}`;
  });
  const omitted = issues.length - shown.length;
  if (omitted > 0) lines.push(`…and ${omitted} more open issues (omitted)`);
  return ['## Open-issue knowledge base', '', ...lines].join('\n');
}

function clipSummary(summary: string | null | undefined): string {
  if (!summary) return '';
  const oneLine = summary.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SUMMARY_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, SUMMARY_MAX_CHARS)}…`;
}

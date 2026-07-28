import { MAX_REF } from './task-refs.ts';

/**
 * In-band task-reference markers (spec 2026-07-18-task-ref-markers): the main
 * agent thread declares its subject PR/issue — and optionally a title — the
 * same way it declares completion with `CEZ:DONE`. Parsed from the accumulated
 * turn text only (the agent's own words, never tool output), so a task that
 * merely *reads* the marker contract cannot poison its record. Marker values
 * outrank the fuzzy discovery layers; precedence lives in the spec's table.
 */

export interface TaskMarkers {
  pr?: number;
  issue?: number;
  title?: string;
}

// Line-anchored so prose that mentions a marker never parses; the instruction
// fragment's own `CEZ:PR=<number>` placeholder is non-numeric and inert.
const PR_MARKER_RE = /^CEZ:PR=(\d+)\s*$/gm;
const ISSUE_MARKER_RE = /^CEZ:ISSUE=(\d+)\s*$/gm;
const TITLE_MARKER_RE = /^CEZ:TITLE=(.+)$/gm;

// Report-tier reference lines (spec 2026-07-21-report-ref-discovery): the
// human-friendly chaining lines pipeline skills end their reports with —
// `PR: #12 (link: https://…/pull/12)` — plus the legacy env-style markers
// older skill versions printed. Same trust boundary as CEZ:* (parsed from the
// agent's own turn text only), one notch below in precedence: an explicit
// CEZ:PR / CEZ:ISSUE in the same turn wins. The skill docs' own placeholders
// (`PR: #<PR number> (link: …)`) are non-numeric and inert.
const REPORT_PR_RE = /^PR: #(\d+) \(link: \S+\)\s*$/gm;
const REPORT_ISSUE_RE = /^Issue: #(\d+) \(link: \S+\)\s*$/gm;
const LEGACY_PR_NUMBER_RE = /^PR_NUMBER=(\d+)\s*$/gm;
const LEGACY_PR_URL_RE = /^PR_URL=\S*\/pull\/(\d+)\s*$/gm;
const LEGACY_ISSUE_NUMBER_RE = /^ISSUE_NUMBER=(\d+)\s*$/gm;

function lastNumber(text: string, re: RegExp): number | undefined {
  let value: number | undefined;
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && n < MAX_REF) value = n;
  }
  return value;
}

/** The turn's declared references. The last occurrence of each marker wins —
 *  an agent that corrects itself mid-turn is believed, not averaged. Within a
 *  turn, an explicit CEZ:* declaration outranks a report-tier line, which
 *  outranks the legacy env-style markers. */
export function parseTaskMarkers(text: string): TaskMarkers {
  const markers: TaskMarkers = {};
  const source = text ?? '';
  const pr =
    lastNumber(source, PR_MARKER_RE) ??
    lastNumber(source, REPORT_PR_RE) ??
    lastNumber(source, LEGACY_PR_NUMBER_RE) ??
    lastNumber(source, LEGACY_PR_URL_RE);
  if (pr !== undefined) markers.pr = pr;
  const issue =
    lastNumber(source, ISSUE_MARKER_RE) ??
    lastNumber(source, REPORT_ISSUE_RE) ??
    lastNumber(source, LEGACY_ISSUE_NUMBER_RE);
  if (issue !== undefined) markers.issue = issue;
  let title: string | undefined;
  for (const match of source.matchAll(TITLE_MARKER_RE)) {
    const t = match[1]?.trim();
    if (t) title = t;
  }
  if (title !== undefined) markers.title = title;
  return markers;
}

const MARKER_LINE = /^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/;

/**
 * Remove complete marker lines from display text — the `stripDoneMarker`
 * precedent. Only `CEZ:*` control lines are stripped: the report-tier
 * reference lines (`PR: #12 (link: …)`) are human-readable by design and
 * stay visible. Best-effort by design: a marker split across streamed v1 chunks
 * may transiently render; parsing always runs on the whole turn text, so the
 * record is never affected. Mirrored for v2 display in the cockpit's
 * `thread-state.ts`.
 */
export function stripTaskMarkers(text: string): string {
  if (!text.includes('CEZ:')) return text;
  return text
    .split('\n')
    .filter((line) => !MARKER_LINE.test(line))
    .join('\n');
}

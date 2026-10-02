/**
 * Task dispatch — the PURE half (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 * Everything here is a function of its arguments: how much budget a parent has left, what a task
 * order reads like, what a settled child's report says. The stateful half — creating child runs,
 * waking a parent — lives in `RunManager` (`workflows/run.ts`), which owns the store, the queue and
 * the timers. Both turn-end handlers route through ONE helper there, and it stays short because
 * the arithmetic and the prose live here, under test on their own.
 */
import {
  DISPATCH_MAX_IN_FLIGHT,
  type DispatchInput,
  type DispatchPendingReport,
  type DispatchReport,
  type RunDispatch,
} from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

/**
 * Children in flight under ONE parent — the CONTRACT's value, re-exported rather than restated.
 * The schema bounds a user's `inFlight` by it (`dispatchIntentSchema`), `dispatch()` enforces it,
 * and `cez task --help` tells the agent what it is: three enforcement points for one brake, and a
 * second literal `4` here is how they drift.
 */
export const MAX_CHILDREN_IN_FLIGHT = DISPATCH_MAX_IN_FLIGHT;

/** How many settled-child reports a parent keeps waiting for its next session. A
 *  bound, not a policy: the list is flushed into a PROMPT, and an unbounded one would grow into
 *  a context window no model can read. */
export const MAX_PENDING_REPORTS = 20;

/** A child that still counts against the in-flight cap — anything that has not settled. */
const IN_FLIGHT_STATUSES: readonly string[] = ['queued', 'running', 'waiting'];

/** The four settled statuses. A child reaching any of them reports to its parent — `cancelled`
 *  included, because a parent waiting on a child a user killed would otherwise wait forever. */
export const TERMINAL_STATUSES: readonly string[] = ['done', 'review', 'failed', 'cancelled'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Every run whose `dispatch.parentRunId` names this parent, in store order. */
export function childrenOf(runs: readonly RunRecord[], parentId: string): RunRecord[] {
  return runs.filter((run) => run.dispatch?.parentRunId === parentId);
}

/** The subset still working — what the fan-out cap counts. */
export function inFlightChildren(runs: readonly RunRecord[], parentId: string): RunRecord[] {
  return childrenOf(runs, parentId).filter((run) => IN_FLIGHT_STATUSES.includes(run.status));
}

/**
 * What a parent may still hand out: `budgetUsd − costUsd − Σ children.budgetUsd` (spec §Budget).
 *
 * `undefined` means UNCAPPED — the parent was given no ceiling, which is the pre-existing
 * behaviour of every cezar run, so a spawn under it is never refused for cost. Children are read
 * from the store rather than tracked, because a restart must not forget what is already promised;
 * a child with no ceiling of its own consumes nothing here, which is exactly why a spawn is only
 * allowed to omit `max_cost` while something is left.
 */
export function remainingBudgetUsd(parent: RunRecord, children: readonly RunRecord[]): number | undefined {
  const budget = parent.dispatch?.budgetUsd;
  if (budget === undefined) return undefined;
  // A child still in flight reserves its whole ceiling — it may yet spend it. A SETTLED child is
  // charged what it actually cost, so the unspent part of its reservation flows back to the
  // parent. Without this a commander's headroom only ever shrank: three audits lost their final
  // child to a refusal that fired while real budget remained. `costUsd ?? budgetUsd` keeps
  // a settled child with no recorded cost from being under-charged by a data gap.
  const promised = children.reduce((sum, child) => {
    // Zero may be a preliminary/partial report, even within a single step or
    // invocation. We have no cost-completeness evidence, so preserve the pre-zero-
    // reporting budget behavior: zero remains visible but cannot release a reservation.
    const settledCost = child.costUsd !== undefined && child.costUsd > 0
      ? child.costUsd : undefined;
    return sum + (isTerminalStatus(child.status)
      ? (settledCost ?? child.dispatch?.budgetUsd ?? 0)
      : (child.dispatch?.budgetUsd ?? 0));
  }, 0);
  return budget - (parent.costUsd ?? 0) - promised;
}

/** A dollar amount as the transcript and the task order spell it. */
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The task order one child receives: the objective it was given, then everything the parent
 * decided ABOUT it as a labelled block.
 *
 * A child sees this text and nothing else the parent knows — separate session, separate worktree,
 * separate budget — so an omitted field is a field the child will invent for itself. The parent's
 * branch and run id are always listed: the branch is what the child forked from (and what its own
 * work will be merged back into), and the run id is what makes a report traceable.
 */
export function childTaskEnvelope(
  child: DispatchInput,
  parent: { id: string; branch?: string },
  /** Extra order lines the ENGINE composes — the tree directory paths (`treeEnvelopeLines`). */
  extraLines: readonly string[] = [],
): string {
  const lines: string[] = [];
  const kind = child.kind ?? 'implement';
  if (kind === 'review') {
    lines.push('- Kind: review — you review the work named below and give a verdict; you do not implement it');
  }
  if (child.review_of?.length) lines.push(`- Review of: ${child.review_of.join(', ')}`);
  if (child.scope) lines.push(`- Scope: ${child.scope}`);
  if (child.allowed_tools?.length) lines.push(`- Allowed tools: ${child.allowed_tools.join(', ')}`);
  if (child.max_cost !== undefined) lines.push(`- Max cost: ${usd(child.max_cost)}`);
  if (child.success_criteria) lines.push(`- Success criteria: ${child.success_criteria}`);
  if (child.required_evidence) lines.push(`- Required evidence: ${child.required_evidence}`);
  if (child.retry_limit !== undefined) {
    lines.push(`- Retry limit: ${child.retry_limit} (cezar continues you after an unfinished turn at most ${child.retry_limit} time${child.retry_limit === 1 ? '' : 's'}, then parks you)`);
  }
  if (parent.branch) lines.push(`- Parent branch (your fork point): ${parent.branch}`);
  lines.push(`- Ordered by: run ${parent.id}`);
  lines.push(...extraLines);
  return `${child.objective}\n\n## Task order\n${lines.join('\n')}`;
}

/** Lines of one markdown section of a handoff file, the way `handoffProgressExcerpt` reads the
 *  progress log. Used for the fallback body of a report a child never wrote itself. */
export function handoffSectionExcerpt(text: string, header: string, maxLines = 4): string {
  const idx = text.indexOf(header);
  if (idx < 0) return '';
  const lines: string[] = [];
  for (const line of text.slice(idx + header.length).split('\n')) {
    if (line.startsWith('## ')) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines.push(trimmed);
    if (lines.length >= maxLines) break;
  }
  return lines.join('\n');
}

/** What a settled run's cezar status means as a REPORT status, for a child that never filed a
 *  report of its own (`cez task report`). `review` is work finished and waiting for a human, not
 *  a failure; `cancelled` is neither done nor failed — somebody stopped it, which is a block. */
function statusToReportStatus(status: string): DispatchReport['status'] {
  if (status === 'done' || status === 'review') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'blocked';
  return 'partial';
}

/**
 * The report a settled child hands its parent, in both shapes it is needed in: the STRUCTURED
 * one (persisted on the parent as a pending report, so a restart cannot lose it) and the PROSE
 * one (delivered into the parent's session, which reads text, not JSON).
 *
 * A child that called `cez task report` reports what it said. One that did not — it crashed, was
 * cancelled, or simply forgot — still reports: its status, its resume notes if it left any, and
 * its error. A silent settle would leave the parent monitoring a child that will never speak.
 */
export function childSettleReport(
  child: RunRecord,
  context: { resumeNotes?: string } = {},
): { text: string; report: DispatchReport } {
  const own = child.dispatch?.report;
  // A run that settled while still parked on its own question never got its answer: that is a
  // BLOCK, whatever cezar's terminal status says. A restart force-settles every `waiting` run as
  // `done`, and reporting that upward as success would turn "I stopped and asked before doing
  // something irreversible" into a clean `done` nobody ever answered — the Guard's whole premise.
  const unanswered = own ? undefined : child.dispatch?.pendingAsk;
  // The retry cap stopped cezar before the task finished; the run settles unfinished, and the
  // parent hears `partial` rather than reading the ceiling as a finished job.
  const retryLimited = own || unanswered ? undefined : child.dispatch?.retryLimitReached;
  const report: DispatchReport =
    own ??
    (unanswered
      ? ({
          status: 'blocked',
          result: `unanswered question — the run settled (${child.status}) before a reply arrived: ${unanswered.questions.join(' | ')}`,
          evidence: [],
          side_effects: [],
          errors: child.error ? [child.error] : [],
          suggestions: [],
        } satisfies DispatchReport)
      : retryLimited
        ? ({
            status: 'partial',
            result:
              child.error?.trim() ||
              'the retry limit stopped cezar auto-continuing before the task finished — continue it to keep going',
            evidence: [],
            side_effects: [],
            errors: child.error ? [child.error] : [],
            suggestions: [],
          } satisfies DispatchReport)
        : ({
            status: statusToReportStatus(child.status),
            result:
              context.resumeNotes?.trim() ||
              child.error?.trim() ||
              'no structured report — the run settled without calling `cez task report`',
            evidence: [],
            side_effects: [],
            errors: child.error ? [child.error] : [],
            suggestions: [],
          } satisfies DispatchReport));

  const where = child.branch
    ? `${child.id}, branch ${child.branch}${child.baseBranch ? ` off ${child.baseBranch}` : ''}`
    : `${child.id}, no branch — it ran in the repository working tree`;
  const parts: string[] = [`status ${report.status} (cezar: ${child.status})`, report.result];
  if (report.evidence.length) parts.push(`evidence: ${report.evidence.join(' · ')}`);
  if (report.errors.length) parts.push(`errors: ${report.errors.join(' · ')}`);
  if (report.side_effects.length) parts.push(`side effects: ${report.side_effects.join(' · ')}`);
  if (report.verdict) parts.push(`verdict: ${report.verdict}`);
  if (report.recommended_next_action) parts.push(`recommended next: ${report.recommended_next_action}`);
  if (report.suggestions.length) parts.push(`suggestions for the root: ${report.suggestions.join(' · ')}`);
  if (child.costUsd !== undefined) parts.push(`cost ${usd(child.costUsd)}`);
  if (child.diffStat) {
    parts.push(`diff ${child.diffStat.files} files, +${child.diffStat.adds} -${child.diffStat.dels}`);
  }
  if (child.dispatch?.scopeCheck) parts.push(child.dispatch.scopeCheck);
  const text = `Report from task "${child.title}" (${where}): ${parts.join('; ')}`;
  return { text, report };
}

/** Append a report to a parent's pending list, keeping the newest `MAX_PENDING_REPORTS` and
 *  counting the ones trimmed off, so the flushed block can say they exist. */
export function withPendingReport(dispatch: RunDispatch, entry: DispatchPendingReport): RunDispatch {
  const all = [...(dispatch.pendingReports ?? []), entry];
  const dropped = Math.max(0, all.length - MAX_PENDING_REPORTS);
  const droppedReports = (dispatch.droppedReports ?? 0) + dropped;
  return { ...dispatch, pendingReports: all.slice(-MAX_PENDING_REPORTS), ...(droppedReports ? { droppedReports } : {}) };
}

/** Every token that could name a path: a separator, a wildcard, an extension, or a bare word
 *  ("docs"). Prose is not filtered out here — a bare word can only ADD matches, so it errs towards
 *  "inside", and `scopeVerdict` refuses an "outside" verdict when no token clearly names a path. */
function scopePathTokens(scope: string): string[] {
  return scope
    .split(/[\s,;]+/)
    .map(scopePathToken)
    .filter((token) => token.length > 0 && (/[/*?]/.test(token) || /\.[A-Za-z0-9]+$/.test(token) || /^[A-Za-z0-9._-]+$/.test(token)));
}

/** A token that names a path without ambiguity: a glob, a directory (trailing slash) or a file
 *  (extension). Bare words ("docs") and slash-prose ("and/or") match, but cannot on their own
 *  justify telling the parent a correct change fell outside its scope. */
function isUnambiguousPathToken(token: string): boolean {
  return /[*?[{]/.test(token) || token.endsWith('/') || /\.[A-Za-z0-9]+$/.test(token);
}

/** A bare root ("/", ".", "*") means the whole repository; otherwise a token loses the quoting
 *  and sentence punctuation around it and its leading "/" or "./", because `git diff --name-only`
 *  paths are repository-relative. */
function scopePathToken(raw: string): string {
  const quoted = raw.replace(/^[`'"(]+|[`'")]+$/g, '');
  if (/^(\.\/?|\/|\*)$/.test(quoted)) return '*';
  return quoted.replace(/[`'").,:;]+$/, '').replace(/^\.?\/+/, '');
}

/** Everything before the first glob metacharacter: matching by that prefix can only err towards
 *  "inside", so a correct change is never reported as out of scope. */
function literalPrefix(token: string): string {
  const wildcard = token.search(/[*?[{]/);
  return wildcard < 0 ? token : token.slice(0, wildcard);
}

const SCOPE_CHECK_LISTED = 5;

/** The engine's own files-vs-scope verdict for a settled child, as the one line its report carries. */
export function scopeVerdict(scope: string, changedFiles: readonly string[]): string {
  const tokens = scopePathTokens(scope);
  if (tokens.length === 0) return 'scope check: not checked — the declared scope names no paths';
  if (changedFiles.length === 0) return 'scope check: no changed files';
  const inside = (file: string): boolean =>
    tokens.some((token) => {
      const prefix = literalPrefix(token);
      if (prefix !== token || token.endsWith('/')) return file.startsWith(prefix);
      return file === token || file.startsWith(`${token}/`);
    });
  const outside = changedFiles.filter((file) => !inside(file));
  if (outside.length === 0) {
    return `scope check: all ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'} inside the declared scope`;
  }
  // An "outside" verdict needs at least one token that clearly names a path. When every token is
  // prose or a bare word, a file reading outside is a parse failure ("and/or the auth module"),
  // not a finding — and the parent, told not to re-derive it, would reject correct work. This
  // holds however many files matched, so a partial match cannot promote an ambiguous reading.
  if (!tokens.some(isUnambiguousPathToken)) {
    return 'scope check: not checked — the declared scope names no unambiguous paths';
  }
  const listed = outside.slice(0, SCOPE_CHECK_LISTED).join(', ');
  const more = outside.length > SCOPE_CHECK_LISTED ? ` and ${outside.length - SCOPE_CHECK_LISTED} more` : '';
  return `scope check: ${outside.length} of ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'} outside the declared scope: ${listed}${more}`;
}

/**
 * The block prepended to a parent's prompt when its session opens holding pending reports.
 * Rendered as prose rather than JSON for the same reason the delivered message is:
 * a commander reads its children's reports, it does not parse them.
 */
export function pendingReportsBlock(reports: readonly DispatchPendingReport[], dropped = 0): string | undefined {
  if (reports.length === 0) return undefined;
  const lines = reports.map((entry) => {
    const parts = [`status ${entry.report.status}`, entry.report.result];
    if (entry.report.evidence.length) parts.push(`evidence: ${entry.report.evidence.join(' · ')}`);
    if (entry.report.errors.length) parts.push(`errors: ${entry.report.errors.join(' · ')}`);
    if (entry.scopeCheck) parts.push(entry.scopeCheck);
    return `- "${entry.title}" (${entry.fromRunId}, ${entry.at}): ${parts.join('; ')}`;
  });
  if (dropped > 0) {
    lines.unshift(`- ${dropped} older report${dropped === 1 ? ' is' : 's are'} not repeated here — read units/*/report.md in the tree directory`);
  }
  return `## Reports from your dispatched tasks\n${lines.join('\n')}`;
}

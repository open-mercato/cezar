/**
 * The unit hierarchy's PURE half (spec `.ai/specs/2026-09-08-units-hierarchy.md`).
 *
 * Everything here is a function of its arguments: which role is one rung down, how much budget a
 * parent has left, what a task order reads like, what a settled child's report says. The stateful
 * half — parsing a turn, creating child runs, waking a parent — lives in `RunManager`
 * (`workflows/run.ts`), because it is the thing that owns the store, the queue and the timers.
 *
 * The split is not decoration. Both turn-end handlers route through ONE private helper in the
 * manager (AGENTS.md § "the two near-identical turn-end handlers"), and that helper is only short
 * enough to read in one sitting because the arithmetic and the prose live here, under test on
 * their own.
 */
import type { RunUnit, UnitPendingReport, UnitReport, UnitRole, UnitSpawnChild } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';

/** One rung down. `centurion` has no rung below it: legionaries are its backend's own sub-agents,
 *  not cezar runs (spec Q2), which is why a centurion's `CEZ:SPAWN` is refused rather than
 *  silently flattened into a fourth layer of runs. */
export const CHILD_ROLE: Record<UnitRole, UnitRole | undefined> = {
  caesar: 'legate',
  legate: 'centurion',
  centurion: undefined,
};

/** Children in flight under ONE parent (spec Q2). `maxParallel` defaults to 2 and only two
 *  monitors are slot-exempt, so a wider fan-out starves its own tree. */
export const MAX_CHILDREN_IN_FLIGHT = 4;

/** How many settled-child reports a parent keeps waiting for its next session (spec Q7). A
 *  bound, not a policy: the list is flushed into a PROMPT, and an unbounded one would grow into
 *  a context window no model can read. */
export const MAX_PENDING_REPORTS = 20;

/** A child that still counts against the in-flight cap — anything that has not settled. */
const IN_FLIGHT_STATUSES: readonly string[] = ['queued', 'running', 'waiting'];

/** The four settled statuses. A child reaching any of them reports to its parent (spec §Reports
 *  and settle) — `cancelled` included, because a parent waiting on a child a user killed would
 *  otherwise wait forever. */
export const TERMINAL_STATUSES: readonly string[] = ['done', 'review', 'failed', 'cancelled'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Every run whose `unit.parentRunId` names this parent, in store order. */
export function childrenOf(runs: readonly RunRecord[], parentId: string): RunRecord[] {
  return runs.filter((run) => run.unit?.parentRunId === parentId);
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
  const budget = parent.unit?.budgetUsd;
  if (budget === undefined) return undefined;
  const promised = children.reduce((sum, child) => sum + (child.unit?.budgetUsd ?? 0), 0);
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
  child: UnitSpawnChild,
  parent: { id: string; branch?: string; role: UnitRole },
): string {
  const lines: string[] = [];
  if (child.scope) lines.push(`- Scope: ${child.scope}`);
  if (child.allowed_tools?.length) lines.push(`- Allowed tools: ${child.allowed_tools.join(', ')}`);
  if (child.max_cost !== undefined) lines.push(`- Max cost: ${usd(child.max_cost)}`);
  if (child.success_criteria) lines.push(`- Success criteria: ${child.success_criteria}`);
  if (child.required_evidence) lines.push(`- Required evidence: ${child.required_evidence}`);
  if (child.retry_limit !== undefined) lines.push(`- Retry limit: ${child.retry_limit}`);
  if (parent.branch) lines.push(`- Parent branch (your fork point): ${parent.branch}`);
  lines.push(`- Ordered by: the ${parent.role} on run ${parent.id}`);
  return `${child.objective}\n\n## Task order\n${lines.join('\n')}`;
}

/**
 * The claude sub-agent tools a CENTURION needs (spec Q2): its legionaries ARE the backend's own
 * sub-agents, so a centurion whose `allowedTools` omits `Task` has no century at all — it would
 * read its role prompt, try to dispatch, and be denied by its own tool policy.
 *
 * Additive and claude-only: codex/opencode ignore `allowedTools` entirely (#430) and have no
 * equivalent tool, and the centurion prompt already says to do the work itself there.
 */
export function unitSubagentTools(
  base: readonly string[],
  role: UnitRole | undefined,
  backend: RunnerId,
): string[] {
  if (role !== 'centurion' || backend !== 'claude') return [...base];
  const missing = ['Task', 'Agent'].filter((tool) => !base.includes(tool));
  return missing.length ? [...base, ...missing] : [...base];
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

/** What a settled run's cezar status means as a REPORT status, for a child that never emitted a
 *  `CEZ:REPORT` of its own. `review` is work finished and waiting for a human, not a failure;
 *  `cancelled` is neither done nor failed — somebody stopped it, which is a block. */
function statusToReportStatus(status: string): UnitReport['status'] {
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
 * A child that emitted `CEZ:REPORT` reports what it said. One that did not — it crashed, was
 * cancelled, or simply forgot — still reports: its status, its resume notes if it left any, and
 * its error. A silent settle would leave the parent monitoring a child that will never speak.
 */
export function childSettleReport(
  child: RunRecord,
  context: { role: UnitRole; resumeNotes?: string },
): { text: string; report: UnitReport } {
  const own = child.unit?.report;
  const report: UnitReport =
    own ??
    ({
      status: statusToReportStatus(child.status),
      result:
        context.resumeNotes?.trim() ||
        child.error?.trim() ||
        'no structured report — the run settled without emitting CEZ:REPORT',
      evidence: [],
      side_effects: [],
      errors: child.error ? [child.error] : [],
    } satisfies UnitReport);

  const where = child.branch
    ? `${child.id}, branch ${child.branch}${child.baseBranch ? ` off ${child.baseBranch}` : ''}`
    : `${child.id}, no branch — it ran in the repository working tree`;
  const parts: string[] = [`status ${report.status} (cezar: ${child.status})`, report.result];
  if (report.evidence.length) parts.push(`evidence: ${report.evidence.join(' · ')}`);
  if (report.errors.length) parts.push(`errors: ${report.errors.join(' · ')}`);
  if (report.side_effects.length) parts.push(`side effects: ${report.side_effects.join(' · ')}`);
  if (report.recommended_next_action) parts.push(`recommended next: ${report.recommended_next_action}`);
  if (child.costUsd !== undefined) parts.push(`cost ${usd(child.costUsd)}`);
  if (child.diffStat) {
    parts.push(`diff ${child.diffStat.files} files, +${child.diffStat.adds} -${child.diffStat.dels}`);
  }
  const text = `Report from ${context.role} "${child.title}" (${where}): ${parts.join('; ')}`;
  return { text, report };
}

/** Append a report to a parent's pending list, keeping the newest `MAX_PENDING_REPORTS`. */
export function withPendingReport(unit: RunUnit, entry: UnitPendingReport): RunUnit {
  const pendingReports = [...(unit.pendingReports ?? []), entry].slice(-MAX_PENDING_REPORTS);
  return { ...unit, pendingReports };
}

/**
 * The block prepended to a parent's prompt when its session opens holding pending reports
 * (spec Q7). Rendered as prose rather than JSON for the same reason the delivered message is:
 * a commander reads its children's reports, it does not parse them.
 */
export function pendingReportsBlock(reports: readonly UnitPendingReport[]): string | undefined {
  if (reports.length === 0) return undefined;
  const lines = reports.map((entry) => {
    const parts = [`status ${entry.report.status}`, entry.report.result];
    if (entry.report.evidence.length) parts.push(`evidence: ${entry.report.evidence.join(' · ')}`);
    if (entry.report.errors.length) parts.push(`errors: ${entry.report.errors.join(' · ')}`);
    return `- "${entry.title}" (${entry.fromRunId}, ${entry.at}): ${parts.join('; ')}`;
  });
  return `## Reports from your units\n${lines.join('\n')}`;
}

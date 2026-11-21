import { z } from 'zod';
import type { HarnessCouncilRecord, HarnessLedgerResponse } from './harness.ts';

export const harnessValidationCheckRecordSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  exitCode: z.number().int().nullable(),
  evidence: z.string(),
  failureIds: z.array(z.string()).optional(),
  logPath: z.string().optional(),
  preexisting: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  unavailable: z.boolean().optional(),
});
export type HarnessValidationCheckRecord = z.infer<typeof harnessValidationCheckRecordSchema>;

export const harnessEnvironmentSchema = z.object({
  status: z.enum(['ready', 'needs-setup', 'preparing', 'failed']),
  manager: z.enum(['npm', 'yarn', 'pnpm', 'bun']).optional(),
  installCommand: z.string().optional(),
  detail: z.string(),
  checkedAt: z.string().optional(),
  logPath: z.string().optional(),
});
export type HarnessEnvironment = z.infer<typeof harnessEnvironmentSchema>;

export const harnessFindingHistoryRecordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  location: z.string().optional(),
  evidence: z.string().optional(),
  reviewers: z.array(z.string()),
  firstRound: z.number(),
  lastRound: z.number(),
  status: z.enum(['open', 'fixed-unverified', 'resolved', 'environment']),
});
export type HarnessFindingHistoryRecord = z.infer<typeof harnessFindingHistoryRecordSchema>;

export const harnessReviewActionInputSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(['prepare', 'verify', 'fix']),
  revision: z.string().min(1).max(100),
  findingIds: z.array(z.string().min(1).max(100)).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'fix' && !value.findingIds?.length) {
    ctx.addIssue({ code: 'custom', path: ['findingIds'], message: 'Select at least one finding to fix.' });
  }
  if (value.action !== 'fix' && value.findingIds?.length) {
    ctx.addIssue({ code: 'custom', path: ['findingIds'], message: 'Only a fix action selects findings.' });
  }
  if (value.findingIds && new Set(value.findingIds).size !== value.findingIds.length) {
    ctx.addIssue({ code: 'custom', path: ['findingIds'], message: 'Select each finding once.' });
  }
});
export type HarnessReviewActionInput = z.infer<typeof harnessReviewActionInputSchema>;

export const harnessReviewActionRecordSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['prepare', 'verify', 'fix']),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  round: z.number().int().min(1),
  findingIds: z.array(z.string()),
  requestedAt: z.string(),
  subjectSha256: z.string(),
  onePass: z.boolean().optional(),
  error: z.string().optional(),
});
export type HarnessReviewActionRecord = z.infer<typeof harnessReviewActionRecordSchema>;
export const harnessReviewActionResponseSchema = z.object({ action: harnessReviewActionRecordSchema, resumed: z.literal(true) });
export type HarnessReviewActionResponse = z.infer<typeof harnessReviewActionResponseSchema>;

/** These checks never reached project code; baseline comparison cannot turn them green. */
export function harnessCheckUnavailable(check: Pick<HarnessValidationCheckRecord, 'status' | 'evidence' | 'unavailable'>): boolean {
  const missingCommand = /^(?:[^:\n]*sh:\s*)?(?:line \d+:\s*)?[\w./-]+:\s*(?:command not found|not found)\s*$/im.test(check.evidence);
  return check.status === 'failed' && (check.unavailable === true || missingCommand || /couldn.t find the node_modules state file|cannot find (?:module|package) ['"](?:[^'"]*\/)?(?:vitest|typescript|next|jest|turbo)|no such file.*node_modules|ERR_PNPM_NO_IMPORTER_MANIFEST/i.test(check.evidence));
}

export function harnessFailedValidationChecks(checks: readonly HarnessValidationCheckRecord[] = []): HarnessValidationCheckRecord[] {
  return [...new Map(checks.filter((check) => check.status === 'failed' && !check.preexisting && !harnessCheckUnavailable(check))
    .map((check) => [check.command, check])).values()];
}

export function harnessValidationFailureSummary(checks: readonly HarnessValidationCheckRecord[]): string {
  const failed = harnessFailedValidationChecks(checks);
  const commands = failed.map((check) => check.command.split(/\r?\n/)[0]?.slice(0, 100)).join(', ');
  return `${failed.length} project ${failed.length === 1 ? 'check' : 'checks'} failed: ${commands}.`;
}

export function harnessValidationNeedsAttention(ledger: Pick<HarnessLedgerResponse, 'outcome' | 'validation' | 'reviewAction' | 'phases'>): boolean {
  return ledger.outcome.status === 'blocked' && ledger.reviewAction?.status === 'failed' &&
    ledger.phases.some((phase) => phase.id === `operator-validate-${ledger.reviewAction?.id}` && phase.status === 'done') &&
    harnessFailedValidationChecks(ledger.validation).length > 0;
}

function findingId(kind: string, title: string, location = ''): string {
  // Stable identity only; review subjects and publication integrity use SHA-256 on the server.
  const key = `${kind}|${location.replace(/:\d+(?::\d+)?(?:\s.*)?$/, '')}|${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
  let hash = 14695981039346656037n;
  for (const char of key) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return `finding-${hash.toString(16)}`;
}

export function harnessValidationFindingId(command: string): string {
  return findingId('validation', command);
}

/** A completed fresh council resolves reports absent from its full-diff review. */
export function reconcileHarnessFindings(
  previous: readonly HarnessFindingHistoryRecord[],
  council: HarnessCouncilRecord,
  checks: readonly HarnessValidationCheckRecord[] = [],
): HarnessFindingHistoryRecord[] {
  if (!council.verdict || council.reviewers?.some((row) => row.status !== 'completed')) return [...previous];
  const history = new Map(previous.map((row) => [row.id, { ...row, reviewers: [...row.reviewers] }]));
  const observed = new Set<string>();
  const allUnavailable = checks.some(harnessCheckUnavailable) && checks.every((row) => row.status === 'skipped' || harnessCheckUnavailable(row));
  const findings = council.findings ?? council.reviewers?.flatMap((row) => (row.findings ?? []).map((finding) => ({ ...finding, by: finding.by ?? row.id }))) ?? [];
  for (const finding of findings) {
    const environment = council.kind === 'implementation' && allUnavailable &&
      (/^(?:configured|post-generation).*(?:gate|validation)/i.test(finding.title) || harnessCheckUnavailable({ status: 'failed', evidence: finding.evidence ?? '' }));
    const title = environment ? 'Project checks could not run — dependencies or tools are unavailable' : finding.title;
    const id = environment ? 'finding-environment' : findingId(council.kind, title, finding.location);
    const old = history.get(id);
    const severity = observed.has(id) && old && ['blocker', 'major', 'minor', 'nit'].indexOf(old.severity) < ['blocker', 'major', 'minor', 'nit'].indexOf(finding.severity) ? old.severity : finding.severity;
    observed.add(id);
    history.set(id, {
      id, kind: council.kind, title, severity,
      ...(!environment && finding.location ? { location: finding.location } : {}),
      ...(finding.evidence ? { evidence: finding.evidence } : {}),
      reviewers: [...new Set([...(old?.reviewers ?? []), ...(finding.by?.split(/,\s*/) ?? [])])],
      firstRound: old?.firstRound ?? council.round,
      lastRound: council.round,
      status: environment ? 'environment' : 'open',
    });
  }
  for (const row of history.values()) {
    if (row.kind === council.kind && !observed.has(row.id)) row.status = 'resolved';
  }
  return [...history.values()].slice(-1000);
}

/** Additive legacy projection: old ledgers retain their saved councils without migration. */
export function harnessFindingHistory(ledger: {
  findingHistory?: HarnessFindingHistoryRecord[];
  councils: HarnessCouncilRecord[];
  validation?: HarnessValidationCheckRecord[];
  outcome: { status: string };
  phases?: { id: string; status: string }[];
}): HarnessFindingHistoryRecord[] {
  let rows: HarnessFindingHistoryRecord[] = ledger.findingHistory ? ledger.findingHistory.map((row) => ({ ...row })) : [];
  if (!ledger.findingHistory) for (const council of [...ledger.councils].sort((a, b) => a.round - b.round)) {
    rows = reconcileHarnessFindings(rows, council, ledger.validation);
  }
  if (!ledger.findingHistory && ledger.outcome.status === 'contested' && ledger.phases?.some((phase) => phase.id === 'fix-final' && phase.status === 'done')) {
    rows = rows.map((row) => row.kind === 'implementation' && row.status === 'open' ? { ...row, status: 'fixed-unverified' } : row);
  }
  const commands = new Set(ledger.validation?.map((check) => check.command));
  for (const command of commands) {
    const checks = ledger.validation!.filter((check) => check.command === command);
    const check = checks.find((item) => item.status === 'failed' && !item.preexisting && !harnessCheckUnavailable(item)) ?? checks[0]!;
    const id = harnessValidationFindingId(check.command);
    const old = rows.find((row) => row.id === id);
    if (check.status === 'failed' && !check.preexisting && !harnessCheckUnavailable(check)) {
      const round = Math.max(1, ...ledger.councils.filter((row) => row.kind === 'implementation').map((row) => row.round));
      const finding: HarnessFindingHistoryRecord = { id, kind: 'implementation', title: `Validation failed: ${check.command}`, severity: 'blocker', evidence: check.evidence, reviewers: ['validation gate'], firstRound: old?.firstRound ?? round, lastRound: round, status: 'open' };
      rows = [...rows.filter((row) => row.id !== id), finding];
    } else if (old && checks.every((item) => item.status === 'passed')) old.status = 'resolved';
  }
  return rows;
}

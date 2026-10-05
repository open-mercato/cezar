import type {
  DashboardAutomationStat,
  DashboardBackendStat,
  DashboardCostMetric,
  DashboardCoverage,
  DashboardFailureCategory,
  DashboardFailureReason,
  DashboardInsights,
  DashboardInsightsQuery,
  RunRecord,
  RunStatus,
} from '@open-mercato/cezar-contract';
import { projectCostTask, type CostVisibility } from './dashboard-costs.ts';

/** Explicit allowlist, like `projectCostTask`: never prompts, step payloads or session ids. */
export type InsightRow = {
  projectId: string;
  id: string;
  title: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  autoResumeAt?: string;
  awaitingAnswerSince?: string;
  archived: boolean;
  diff?: { adds: number; dels: number; files: number };
  prs: { number: number; created: boolean }[];
  issue?: number;
  error?: string;
  failedStep?: { name: string; kind: 'agent' | 'check'; error?: string };
  backend: string;
  model?: string;
  costUsd?: number;
  automationId?: string;
};

const MESSAGE_MAX = 240;

export function projectInsightRow(projectId: string, run: RunRecord): InsightRow {
  const prs = new Map<number, boolean>();
  for (const ref of run.prRefs ?? [])
    prs.set(ref.number, (prs.get(ref.number) ?? false) || ref.origin === 'created');
  // Records written before `prRefs` carry the PR cezar opened as a bare URL/number.
  if (!run.prRefs?.length && run.prNumber !== undefined && run.pullRequestUrl)
    prs.set(run.prNumber, true);
  const failedStep = [...run.steps].reverse().find((s) => s.status === 'failed');
  // Attribute to what RAN, not what the task was created with: `runner` is fixed at start,
  // while a step may override it, and `modelIdentity` is rewritten by every step from the
  // step's own backend (workflows/run.ts). With one backend across the steps that ran,
  // `modelIdentity` is that backend's model. With several, no single pair is true — say so.
  const ran = [...new Set(run.steps.flatMap((s) => (s.backend ? [s.backend] : [])))];
  const backend = ran.length > 1 ? 'mixed' : (ran[0] ?? run.runner ?? 'unknown');
  const costUsd = projectCostTask(projectId, run).costUsd;
  const automationId = run.automation?.automationId ?? run.automationTrigger?.automationId;
  const model =
    backend === 'mixed'
      ? undefined
      : (run.modelIdentity ?? (backend === run.runner ? run.model : undefined));
  return {
    projectId,
    id: run.id,
    title: run.titleSummary || run.title,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.autoResumeAt !== undefined ? { autoResumeAt: run.autoResumeAt } : {}),
    ...(run.awaitingAnswerSince !== undefined ? { awaitingAnswerSince: run.awaitingAnswerSince } : {}),
    archived: run.archived ?? false,
    ...(run.diffStat
      ? { diff: { adds: run.diffStat.adds, dels: run.diffStat.dels, files: run.diffStat.files } }
      : {}),
    prs: [...prs].map(([number, created]) => ({ number, created })),
    ...(run.issueNumber !== undefined ? { issue: run.issueNumber } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(failedStep
      ? {
          failedStep: {
            name: failedStep.name,
            kind: failedStep.kind,
            ...(failedStep.error ? { error: failedStep.error } : {}),
          },
        }
      : {}),
    backend,
    ...(model ? { model } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(automationId ? { automationId } : {}),
  };
}

const PATTERNS: [DashboardFailureCategory, string, RegExp][] = [
  ['usage-limit', 'Usage or rate limit', /usage limit|rate.?limit|\b429\b|quota|credit balance/i],
  ['auth', 'Authentication', /\b40[13]\b|unauthori[sz]ed|authenticat|not logged in|log ?in required|api key|invalid token/i],
  ['agent-unavailable', 'Agent CLI unavailable', /ENOENT|command not found|not installed|failed to spawn|no such file/i],
  ['timeout', 'Timed out', /timed? ?out|ETIMEDOUT|deadline exceeded/i],
  ['git', 'Git', /\bgit\b|merge conflict|worktree|rebase/i],
];

/** One line, bounded: a record's error can be a whole stack or a CLI's stderr dump. */
function firstLine(text: string, max: number) {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function classifyFailure(row: InsightRow): {
  category: DashboardFailureCategory;
  label: string;
  message: string;
} {
  const raw = row.failedStep?.error ?? row.error ?? '';
  const message = raw ? firstLine(raw, MESSAGE_MAX) : 'No error recorded';
  for (const [category, label, pattern] of PATTERNS)
    if (pattern.test(raw)) return { category, label, message };
  // A check step is the workflow saying no (tests, lint) — group by which check.
  if (row.failedStep?.kind === 'check')
    return { category: 'check', label: `Check failed: ${row.failedStep.name}`, message };
  return { category: 'other', label: raw ? firstLine(raw, 60) : 'No error recorded', message };
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const cycleHours = (row: InsightRow) => {
  const hours = (Date.parse(row.finishedAt ?? '') - Date.parse(row.startedAt ?? row.createdAt)) / 3600000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
};
function costMetric(rows: InsightRow[]): DashboardCostMetric {
  const values = rows.flatMap((r) => (r.costUsd !== undefined ? [r.costUsd] : []));
  const sum = values.reduce((a, b) => a + b, 0);
  return { value: values.length && Number.isFinite(sum) ? sum : null, reportedTasks: values.length };
}
const ACTIVE: RunStatus[] = ['queued', 'running', 'waiting', 'review'];
/** In flight, waiting on a person (including a closed session's unanswered question), or parked
 *  until a usage limit resets. */
const isActive = (r: InsightRow) =>
  !r.archived &&
  (ACTIVE.includes(r.status) || (r.status === 'failed' && (!!r.autoResumeAt || !!r.awaitingAnswerSince)));

/** Same window rule as the overview: local midnight `period - 1` days ago through now. */
export function buildDashboardInsights(
  rows: InsightRow[],
  coverage: DashboardCoverage,
  query: DashboardInsightsQuery,
  visibility: CostVisibility,
  at: number,
): DashboardInsights {
  const offset = query.tzOffsetMinutes * 60000;
  const start =
    Math.floor((at - offset) / 86400000) * 86400000 +
    offset -
    (query.period === '7d' ? 6 : 29) * 86400000;
  const inWindow = (iso: string | undefined) => {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) && t >= start && t <= at;
  };
  // A usage-limit park is `failed` with a resume booked, and an unanswered question is `failed`
  // with a session to reopen: both are waiting, not outcomes.
  const finished = rows.filter(
    (r) =>
      (r.status === 'done' || r.status === 'failed') &&
      !r.autoResumeAt &&
      !r.awaitingAnswerSince &&
      inWindow(r.finishedAt),
  );
  const done = finished.filter((r) => r.status === 'done');
  const failed = finished.filter((r) => r.status === 'failed');

  const prs = new Map<string, boolean>();
  const issues = new Set<string>();
  const measured = done.filter((r) => r.diff);
  for (const r of done) {
    for (const pr of r.prs) {
      const key = `${r.projectId}#${pr.number}`;
      prs.set(key, (prs.get(key) ?? false) || pr.created);
    }
    if (r.issue !== undefined) issues.add(`${r.projectId}#${r.issue}`);
  }

  const reasons = new Map<string, DashboardFailureReason>();
  for (const r of [...failed].sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))) {
    const { category, label, message } = classifyFailure(r);
    const key = `${category}\u0000${label}`;
    const existing = reasons.get(key);
    if (existing) existing.count++;
    else
      reasons.set(key, {
        category,
        label,
        count: 1,
        latest: {
          projectId: r.projectId,
          id: r.id,
          title: r.title,
          at: new Date(Date.parse(r.finishedAt!)).toISOString(),
          ...(r.failedStep ? { step: r.failedStep.name } : {}),
          message,
        },
      });
  }

  const backendGroups = new Map<string, InsightRow[]>();
  for (const r of finished) {
    const key = `${r.backend}\u0000${r.model ?? ''}`;
    backendGroups.set(key, [...(backendGroups.get(key) ?? []), r]);
  }
  const backends: DashboardBackendStat[] = [...backendGroups.values()]
    .map((group) => {
      const hours = group.flatMap((r) => {
        const h = r.status === 'done' ? cycleHours(r) : null;
        return h === null ? [] : [h];
      });
      const first = group[0]!;
      return {
        backend: first.backend,
        ...(first.model ? { model: first.model } : {}),
        finished: group.length,
        done: group.filter((r) => r.status === 'done').length,
        failed: group.filter((r) => r.status === 'failed').length,
        timedTasks: hours.length,
        medianCycleHours: median(hours),
        ...(visibility.cost ? { costUsd: costMetric(group) } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.finished - a.finished ||
        a.backend.localeCompare(b.backend) ||
        (a.model ?? '').localeCompare(b.model ?? ''),
    );

  const automationGroups = new Map<string, InsightRow[]>();
  for (const r of rows) {
    if (!r.automationId || !inWindow(r.createdAt)) continue;
    const key = `${r.projectId}\u0000${r.automationId}`;
    automationGroups.set(key, [...(automationGroups.get(key) ?? []), r]);
  }
  const automations: DashboardAutomationStat[] = [...automationGroups.values()]
    .map((group) => {
      const latest = [...group].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!;
      const lastRunAt = Date.parse(latest.createdAt);
      return {
        projectId: latest.projectId,
        automationId: latest.automationId!,
        tasks: group.length,
        done: group.filter((r) => r.status === 'done').length,
        failed: group.filter((r) => r.status === 'failed' && !r.autoResumeAt && !r.awaitingAnswerSince).length,
        active: group.filter(isActive).length,
        ...(Number.isFinite(lastRunAt) ? { lastRunAt: new Date(lastRunAt).toISOString() } : {}),
        lastStatus: latest.status,
        ...(visibility.cost ? { costUsd: costMetric(group) } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.tasks - a.tasks ||
        a.projectId.localeCompare(b.projectId) ||
        a.automationId.localeCompare(b.automationId),
    );

  return {
    asOf: new Date(at).toISOString(),
    windowStart: new Date(start).toISOString(),
    period: query.period,
    visibility: { ...visibility },
    coverage: structuredClone(coverage),
    delivered: {
      completedTasks: done.length,
      prsOpened: [...prs.values()].filter(Boolean).length,
      prsTouched: prs.size,
      issues: issues.size,
      additions: measured.reduce((n, r) => n + r.diff!.adds, 0),
      deletions: measured.reduce((n, r) => n + r.diff!.dels, 0),
      files: measured.reduce((n, r) => n + r.diff!.files, 0),
      measuredTasks: measured.length,
    },
    failures: {
      total: failed.length,
      reasons: [...reasons.values()]
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, 8),
    },
    backends,
    automations,
  };
}

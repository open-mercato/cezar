import type {
  GithubData,
  GithubRefStatusData,
  ManagerAttentionItem,
  ManagerSnapshot,
  ManagerSnapshotPr,
  ManagerSnapshotProject,
  ManagerSnapshotTask,
} from '@open-mercato/cezar-contract';
import { byLastActivityDesc, lastActivityAt } from '../runs/run-index.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * What a manager sees (spec 2026-10-31-managers § Watching). A snapshot reads what the stores and
 * the GitHub tab's cached calls already know; deriving attention from it is pure, so the key gate
 * in front of every model call can be tested without a process in sight.
 */

/** A connected project, read without ever building its context: a watch tick must not recover runs. */
export interface ManagerProjectSource {
  id: string;
  name: string;
  root: string;
  available: boolean;
  runs(): RunRecord[];
  /** Enabled automations whose newest log line is an error. Empty for a project not open here. */
  automationFailures(): Array<{ id: string; name: string; reason?: string; at: string }>;
}

export interface ManagerGithubFacts {
  list(root: string): Promise<GithubData>;
  refStatus(root: string, prs: number[]): Promise<GithubRefStatusData>;
}

const TASK_LIMIT = 50;
const STALLED_MS = 2 * 60 * 60_000;
const RECENT_FAILURE_MS = 7 * 24 * 60 * 60_000;
const PROJECT_CONCURRENCY = 4;

function taskRow(run: RunRecord, childCount: number): ManagerSnapshotTask {
  return {
    runId: run.id,
    title: run.titleSummary ?? run.title,
    status: run.status,
    workflow: run.workflow,
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    ...(run.dispatch?.parentRunId !== undefined ? { parentRunId: run.dispatch.parentRunId } : {}),
    childCount,
    ...(run.diffStat ? { additions: run.diffStat.adds, deletions: run.diffStat.dels } : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    lastActivityAt: lastActivityAt(run),
  };
}

const childCounts = (runs: RunRecord[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const parent = run.dispatch?.parentRunId;
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
};

/** A big tree reads as its root; `cez manager task <run>` opens the children. */
export function snapshotTasks(runs: RunRecord[]): ManagerSnapshotTask[] {
  const counts = childCounts(runs);
  const open = runs.filter((run) => !run.archived && !run.dispatch?.parentRunId).sort(byLastActivityDesc);
  return open.slice(0, TASK_LIMIT).map((run) => taskRow(run, counts.get(run.id) ?? 0));
}

export function taskDetailRows(runs: RunRecord[], runId: string): { task: ManagerSnapshotTask; children: ManagerSnapshotTask[] } | undefined {
  const counts = childCounts(runs);
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) return undefined;
  return {
    task: taskRow(run, counts.get(run.id) ?? 0),
    children: runs.filter((candidate) => candidate.dispatch?.parentRunId === runId).map((child) => taskRow(child, counts.get(child.id) ?? 0)),
  };
}

const unseenSince = (run: RunRecord, at: string | undefined): boolean =>
  at !== undefined && (run.seenAt === undefined || Date.parse(run.seenAt) < Date.parse(at));

/** Keys carry the moment a thing happened, so the same task failing again is news again. */
export function taskAttention(projectId: string, runs: RunRecord[], now: number): ManagerAttentionItem[] {
  const items: ManagerAttentionItem[] = [];
  for (const run of runs) {
    if (run.archived) continue;
    const title = run.titleSummary ?? run.title;
    const base = { projectId, title, runId: run.id };
    if (run.status === 'waiting' && run.awaitingAnswerSince !== undefined) {
      items.push({ ...base, key: `task-needs-you:${projectId}:${run.id}:${run.awaitingAnswerSince}`, kind: 'task-needs-you', since: run.awaitingAnswerSince });
      continue;
    }
    // A dispatched child reports to its parent; only a question reaches the human.
    if (run.dispatch?.parentRunId) continue;
    const finished = run.finishedAt;
    if (run.status === 'failed' && unseenSince(run, finished) && now - Date.parse(finished ?? '') < RECENT_FAILURE_MS) {
      items.push({ ...base, key: `task-failed:${projectId}:${run.id}:${finished}`, kind: 'task-failed', since: finished });
    } else if (run.status === 'review' && unseenSince(run, finished)) {
      items.push({ ...base, key: `task-review:${projectId}:${run.id}:${finished}`, kind: 'task-review', since: finished });
    } else if (run.status === 'running' && now - Date.parse(lastActivityAt(run)) > STALLED_MS) {
      const since = lastActivityAt(run);
      items.push({ ...base, key: `task-stalled:${projectId}:${run.id}:${since}`, kind: 'task-stalled', since });
    }
  }
  return items;
}

export function prAttention(projectId: string, prs: ManagerSnapshotPr[]): ManagerAttentionItem[] {
  const items: ManagerAttentionItem[] = [];
  for (const pr of prs) {
    if (pr.draft) continue;
    const base = { projectId, title: pr.title, number: pr.number, ...(pr.url ? { url: pr.url } : {}) };
    const add = (kind: ManagerAttentionItem['kind']) => items.push({ ...base, key: `${kind}:${projectId}:${pr.number}`, kind });
    if (pr.mergeable === false) add('pr-conflict');
    if (pr.status === 'checks-failing') add('pr-checks-failing');
    else if (pr.status === 'ready' && pr.mergeable !== false) add('pr-ready');
    else if (pr.status === 'review-required') add('pr-review-requested');
  }
  return items;
}

async function projectPrs(
  source: ManagerProjectSource,
  github: ManagerGithubFacts,
): Promise<{ prs: ManagerSnapshotPr[]; prsUnavailable?: string }> {
  try {
    const listed = await github.list(source.root);
    if (!listed.available) return { prs: [], prsUnavailable: listed.reason ?? 'GitHub is unavailable' };
    const status = listed.prs.length > 0 ? await github.refStatus(source.root, listed.prs.map((pr) => pr.number)) : undefined;
    const known = status?.available ? status : undefined;
    return {
      prs: listed.prs.map((pr) => {
        const reference = known?.prs[pr.number];
        const conflicts = known?.conflicts;
        return {
          number: pr.number,
          title: pr.title,
          author: pr.author,
          url: pr.url,
          ...(pr.isDraft !== undefined ? { draft: pr.isDraft } : {}),
          // Absent list = nothing known about mergeability, never "no conflicts".
          ...(reference !== undefined ? { status: reference } : pr.checks === 'failing' ? { status: 'checks-failing' } : {}),
          ...(conflicts ? { mergeable: !conflicts.includes(pr.number) } : {}),
        };
      }),
    };
  } catch (error) {
    return { prs: [], prsUnavailable: error instanceof Error ? error.message : String(error) };
  }
}

export async function buildSnapshot(
  sources: ManagerProjectSource[],
  github: ManagerGithubFacts,
  now: number,
): Promise<ManagerSnapshot> {
  const results: Array<{ project: ManagerSnapshotProject; attention: ManagerAttentionItem[] }> = [];
  const queue = sources.map((source, index) => ({ source, index }));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { source, index } = next;
      if (!source.available) {
        results[index] = {
          project: { projectId: source.id, name: source.name, available: false, prsUnavailable: 'The project folder is missing', tasks: [], prs: [] },
          attention: [],
        };
        continue;
      }
      const runs = source.runs();
      const { prs, prsUnavailable } = await projectPrs(source, github);
      const failures = source.automationFailures().map((failure): ManagerAttentionItem => ({
        key: `automation-failing:${source.id}:${failure.id}:${failure.at}`,
        kind: 'automation-failing',
        projectId: source.id,
        title: failure.name,
        ...(failure.reason ? { detail: failure.reason } : {}),
        since: failure.at,
      }));
      results[index] = {
        project: {
          projectId: source.id,
          name: source.name,
          available: true,
          ...(prsUnavailable ? { prsUnavailable } : {}),
          tasks: snapshotTasks(runs),
          prs,
        },
        attention: [...taskAttention(source.id, runs, now), ...prAttention(source.id, prs), ...failures],
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROJECT_CONCURRENCY, sources.length) }, worker));
  return {
    generatedAt: new Date(now).toISOString(),
    projects: results.map((result) => result.project),
    attention: results.flatMap((result) => result.attention),
  };
}

/** The keys a check has not spoken about, and the reported map it should persist. */
export function gateAttention(
  snapshot: ManagerSnapshot,
  reported: Record<string, string>,
): { fresh: ManagerAttentionItem[]; kept: Record<string, string> } {
  const current = new Set(snapshot.attention.map((item) => item.key));
  // A failed PR read says nothing about that project's PRs: forgetting their keys would re-report them.
  const blind = new Set(snapshot.projects.filter((project) => project.prsUnavailable).map((project) => project.projectId));
  const kept = Object.fromEntries(Object.entries(reported).filter(([key]) => {
    if (current.has(key)) return true;
    const [kind, projectId] = key.split(':');
    return kind?.startsWith('pr-') === true && projectId !== undefined && blind.has(projectId);
  }));
  return { fresh: snapshot.attention.filter((item) => reported[item.key] === undefined), kept };
}

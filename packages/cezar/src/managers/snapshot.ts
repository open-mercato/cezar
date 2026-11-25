import type {
  GithubData,
  GithubRefStatusData,
  ManagerAttentionItem,
  ManagerSnapshot,
  ManagerSnapshotPr,
  ManagerSnapshotProject,
  ManagerSnapshotTask,
  ManagerTaskReportState,
} from '@open-mercato/cezar-contract';
import { taskAskRecordSchema } from '@open-mercato/cezar-contract';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { byLastActivityDesc, lastActivityAt } from '../runs/run-index.ts';
import { reconcileLoadedRun, runRecordSchema, type RunRecord } from '../runs/store.ts';
import { lifecycleBusy } from '../worktree-lifecycle/coordinator.ts';

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

/** `runs.json` of a project not open here. Unlike `readRunIndexFromDisk`, a live row stays live:
 *  another cockpit may own it, and the "interrupted" a cold read stamps would be a new attention key,
 *  so a paid turn, on every check. A dead running one surfaces as stalled; a wait stays a wait. */
export function readColdRuns(dataDir: string): RunRecord[] {
  const path = join(dataDir, 'runs.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = z.array(runRecordSchema).safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) return [];
    return parsed.data.map((run) => reconcileLoadedRun(run, { keepLive: true }));
  } catch {
    return [];
  }
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
    startedBy: run.startedByManager ? 'manager' : 'user',
    ...(run.startedByManager ? { startedByManager: run.startedByManager.name } : {}),
    ...(run.runner ? { runner: run.runner } : {}),
    ...(run.modelIdentity ?? run.model ? { model: run.modelIdentity ?? run.model } : {}),
    ...(run.actualModel ? { actualModel: run.actualModel } : {}),
    ...(run.reasoningEffort ? { effort: run.reasoningEffort } : {}),
    ...pullRequestOf(run),
    ...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
    ...(run.cancelledBy ? { cancelledBy: run.cancelledBy } : {}),
    ...(run.agentSwitch ? { agentSwitch: run.agentSwitch.summary } : {}),
  };
}

const PR_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/;

/** The PR the task opened, else the one it declared (`CEZ:PR`): what tells a manager the work exists. */
function pullRequestOf(run: RunRecord): { prNumber?: number; prUrl?: string } {
  const opened = run.prRefs?.find((ref) => ref.origin === 'created') ?? run.prRefs?.find((ref) => ref.origin === 'marker');
  const url = opened?.url ?? run.pullRequestUrl;
  const number = opened?.number ?? (url ? Number(PR_NUMBER.exec(url)?.[1]) || undefined : undefined) ?? run.markerRefs?.pr;
  return { ...(number !== undefined ? { prNumber: number } : {}), ...(url ? { prUrl: url } : {}) };
}

/**
 * How a task is tied to PR `number`: 0 opened it, 1 declared it (`CEZ:PR`), 2 only carries it
 * (a derived or legacy ref); `undefined` when it does not carry it at all. The cockpit's
 * `ownershipTier` ranks the same way.
 */
export function prTie(run: RunRecord, number: number): 0 | 1 | 2 | undefined {
  const refs = run.prRefs ?? [];
  const urlNumber = run.pullRequestUrl ? Number(PR_NUMBER.exec(run.pullRequestUrl)?.[1]) : undefined;
  if (urlNumber === number || refs.some((ref) => ref.origin === 'created' && ref.number === number)) return 0;
  if (run.markerRefs?.pr === number || refs.some((ref) => ref.origin === 'marker' && ref.number === number)) return 1;
  return refs.some((ref) => ref.number === number) ? 2 : undefined;
}

const childCounts =(runs: RunRecord[]): Map<string, number> => {
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

/** Finished tasks a compact listing still shows per project, newest first. */
const RECENT_FINISHED = 20;
const FINISHED = new Set(['done', 'cancelled']);

/** Every unfinished task, plus the newest finished ones (spec 2026-11-21 § 2.4). */
export function recentTasks<T extends { status: string; lastActivityAt?: string }>(tasks: T[]): { shown: T[]; hidden: number } {
  const finished = tasks.filter((task) => FINISHED.has(task.status))
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const kept = new Set(finished.slice(0, RECENT_FINISHED));
  const shown = tasks.filter((task) => !FINISHED.has(task.status) || kept.has(task));
  return { shown, hidden: tasks.length - shown.length };
}

/** A run by its id, or by a prefix of at least eight characters that names only it (the branch's `cez/<id8>`). */
export function findRun(runs: RunRecord[], runId: string): RunRecord | undefined {
  const exact = runs.find((candidate) => candidate.id === runId);
  if (exact || runId.length < 8) return exact;
  const matches = runs.filter((candidate) => candidate.id.startsWith(runId));
  return matches.length === 1 ? matches[0] : undefined;
}

export function taskDetailRows(runs: RunRecord[], runId: string): { task: ManagerSnapshotTask; children: ManagerSnapshotTask[] } | undefined {
  const counts = childCounts(runs);
  const run = findRun(runs, runId);
  if (!run) return undefined;
  return {
    task: taskRow(run, counts.get(run.id) ?? 0),
    children: runs.filter((candidate) => candidate.dispatch?.parentRunId === run.id).map((child) => taskRow(child, counts.get(child.id) ?? 0)),
  };
}

const WORKTREE_RECOVERY = 'Worktree scripts need attention: use Retry, Start task anyway or Cancel in the Worktrees settings';

const waitDetail = (run: RunRecord): string | undefined =>
  run.attentionRequest?.questions[0]?.question ?? (run.dispatch?.overBudget ? 'Budget reached' : undefined);

/** An idle close is housekeeping, not news: a legacy or dispatched-child record that settled `failed`
 *  on it is never reported (spec 2026-11-04-idle-closed-attention-state § Revision). */
const idleClosedFailure = (run: RunRecord): boolean =>
  run.status === 'failed' && run.idleClosedAt !== undefined && run.awaitingAnswerSince === undefined;

const unseenSince = (run: RunRecord, at: string | undefined): boolean =>
  at !== undefined && (run.seenAt === undefined || Date.parse(run.seenAt) < Date.parse(at));

/** A wait on the user, the way the watch keys it: one identity per wait, so a manager reports it once. */
function userWait(projectId: string, run: RunRecord): { key: string; since: string; detail?: string; worktree: boolean } | undefined {
  const gate = run.worktreeLifecycle;
  if (gate?.needsAttention) {
    // A retry reuses the operation, so the revision is what makes its next failure a new wait.
    const operation = gate.activeOperationId ? `${gate.activeOperationId}:${gate.revision ?? 0}` : `${gate.worktreeId}:${gate.generation}`;
    return { key: `task-needs-you:${projectId}:${run.id}:worktree:${operation}`, since: run.waitingSince ?? lastActivityAt(run), detail: WORKTREE_RECOVERY, worktree: true };
  }
  if ((run.status === 'waiting' && !lifecycleBusy(gate)) || (run.status === 'failed' && run.awaitingAnswerSince !== undefined)) {
    const since = run.waitingSince ?? run.awaitingAnswerSince ?? lastActivityAt(run);
    const detail = waitDetail(run);
    return { key: `task-needs-you:${projectId}:${run.id}:${since}`, since, ...(detail ? { detail } : {}), worktree: false };
  }
  return undefined;
}

/** The watch's key for a settled run; `taskEventOf` marks these reported so no check repeats them. */
export const settledKey = (kind: 'task-failed' | 'task-review' | 'task-finished', projectId: string, run: { id: string; finishedAt?: string }): string =>
  `${kind}:${projectId}:${run.id}:${run.finishedAt}`;

/** Keys carry the moment a thing happened, so the same task failing again is news again. */
export function taskAttention(projectId: string, runs: RunRecord[], now: number): ManagerAttentionItem[] {
  const items: ManagerAttentionItem[] = [];
  for (const run of runs) {
    if (run.archived) continue;
    const title = run.titleSummary ?? run.title;
    const base = { projectId, title, runId: run.id };
    const wait = userWait(projectId, run);
    if (wait) {
      items.push({ ...base, key: wait.key, kind: 'task-needs-you', ...(wait.detail ? { detail: wait.detail } : {}), ...(wait.worktree ? (run.waitingSince ? { since: run.waitingSince } : {}) : { since: wait.since }) });
      // A finished task keeps its outcome; an open wait comes back once the worktree is sorted.
      if (!wait.worktree || run.status === 'waiting' || run.awaitingAnswerSince !== undefined) continue;
    }
    // A dispatched child reports to its parent; only a wait on the user reaches the human.
    if (run.dispatch?.parentRunId) continue;
    const finished = run.finishedAt;
    if (run.status === 'failed' && !idleClosedFailure(run) && unseenSince(run, finished) && now - Date.parse(finished ?? '') < RECENT_FAILURE_MS) {
      items.push({ ...base, key: settledKey('task-failed', projectId, run), kind: 'task-failed', since: finished });
    } else if (run.status === 'review' && unseenSince(run, finished)) {
      items.push({ ...base, key: settledKey('task-review', projectId, run), kind: 'task-review', since: finished });
    } else if (run.status === 'done' && unseenSince(run, finished) && now - Date.parse(finished ?? '') < RECENT_FAILURE_MS) {
      items.push({ ...base, key: settledKey('task-finished', projectId, run), kind: 'task-finished', since: finished });
    } else if (run.status === 'running' && now - Date.parse(lastActivityAt(run)) > STALLED_MS) {
      const since = lastActivityAt(run);
      items.push({ ...base, key: `task-stalled:${projectId}:${run.id}:${since}`, kind: 'task-stalled', since });
    }
  }
  return items;
}

/** What a manager following a task hears about (spec § Followed tasks). */
export interface TaskEvent {
  state: ManagerTaskReportState;
  /** When it happened: a follow hears only what happened after it began. */
  at: string;
  /** One per event: a repeat of the same state, a restart or `review → done` find it already posted. */
  ledger: string;
  /** The watch's keys for it, marked reported once the card is posted. */
  attentionKeys: string[];
  detail?: string;
}

/**
 * The question a waiting task is parked on, as a manager's relayed card names it (`about.ask`,
 * Questions inbox spec): the newest open `RunRecord.asks` entry's card id, else its `requestId`,
 * else the dispatch Guard's. `asks` is read defensively: older records have none.
 */
export function openTaskAskId(run: RunRecord): string | undefined {
  const asks = (run as { asks?: unknown }).asks;
  if (Array.isArray(asks)) {
    for (let index = asks.length - 1; index >= 0; index -= 1) {
      const parsed = taskAskRecordSchema.safeParse(asks[index]);
      if (parsed.success && !parsed.data.closed) return parsed.data.cardId ?? parsed.data.requestId;
    }
  }
  return run.dispatch?.pendingAsk?.requestId;
}

/** Pure, so the live listener, the boot sweep and the watch agree on what one event is. */
export function taskEventOf(projectId: string, run: RunRecord): TaskEvent | undefined {
  if (run.archived) return undefined;
  const wait = userWait(projectId, run);
  if (wait) {
    return { state: 'needs-you', at: wait.since, ledger: `${projectId}/${run.id}:${wait.key}`, attentionKeys: [wait.key], ...(wait.detail ? { detail: wait.detail } : {}) };
  }
  const at = run.finishedAt;
  if (!at) return undefined;
  const event = (state: ManagerTaskReportState, outcome: string, attentionKeys: string[]): TaskEvent => ({
    state, at, ledger: `${projectId}/${run.id}:${outcome}:${at}`, attentionKeys,
    ...(state === 'failed' && run.error ? { detail: run.error } : {}),
  });
  // `review → done` keeps `finishedAt`: one success, reported once.
  const success = [settledKey('task-review', projectId, run), settledKey('task-finished', projectId, run)];
  if (run.status === 'review') return event('review', 'success', success);
  if (run.status === 'done') return event('done', 'success', success);
  if (run.status === 'failed') return idleClosedFailure(run) ? undefined : event('failed', 'failed', [settledKey('task-failed', projectId, run)]);
  if (run.status === 'cancelled') return event('cancelled', 'cancelled', []);
  return undefined;
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
      // No status is no knowledge: `gateAttention` must keep these keys, not forget and re-bill them.
      ...(listed.prs.length > 0 && !known ? { prsUnavailable: 'Pull request status is unavailable' } : {}),
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

import { createHash } from 'node:crypto';
import {
  RUN_PR_REF_RANK,
  type AttentionCounts,
  type AttentionItem,
  type AttentionKind,
  type AttentionOverride,
  type AttentionResponse,
  type AttentionSettled,
  type ManagerMessage,
  type ManagerSummary,
  type QuestionItem,
} from '@open-mercato/cezar-contract';
import { taskAttention } from '../managers/snapshot.ts';
import { activeOverrides } from './overrides.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * The attention list (spec 2026-11-20-phone-notifications-inbox, variant D): one list per computer,
 * every count a filter of it. Task rows reuse the manager watch's rules (`taskAttention`), so a push
 * for a waiting task and the row it lands on are the same thing.
 */

type Action = Extract<ManagerMessage, { kind: 'action' }>;

export interface AttentionSources {
  /** Open questions from the Questions inbox. Older ones are dropped here, as they are not counted. */
  questions: readonly QuestionItem[];
  managers: readonly Pick<ManagerSummary, 'id' | 'name' | 'notify' | 'inactive' | 'important' | 'headline' | 'lastActivityAt'>[];
  approvals: ReadonlyArray<{ managerId: string; message: Action; title: string }>;
  projects: ReadonlyArray<{ id: string; runs: readonly RunRecord[] }>;
  now: number;
  /** The Questions page's Older days (`0` = off): a question or a paused task open longer is probably done. */
  olderAfterDays?: number;
  /** The task's CURRENT pull request, when the forge cache already knows it ended, and when. Never asks the forge. */
  prEnded?: (projectId: string, run: RunRecord) => PrEnd & { number: number } | undefined;
  /** Any PR in a project, as the forge cache already knows it: a question card's declared or mentioned PR. */
  prState?: (projectId: string, number: number) => PrEnd | undefined;
  overrides?: readonly AttentionOverride[];
}

const DAY_MS = 24 * 60 * 60_000;

export interface PrEnd {
  state: 'merged' | 'closed';
  /** When it ended; unknown never settles anything. */
  endedAt?: string;
}

/** Only a PR that ended after the wait or question began says it is done: one that ended before
 *  was already over when the task asked again. */
const endedAfter = (ended: PrEnd | undefined, since: string): ended is PrEnd => {
  const at = ended?.endedAt ? Date.parse(ended.endedAt) : Number.NaN;
  const start = Date.parse(since);
  return Number.isFinite(at) && Number.isFinite(start) && at > start;
};

/** Tiers (spec 2026-11-23-needs-you-triage § Order): blocking decisions, the review gate, waits, failures. */
const TIER: Record<AttentionKind, number> = { approval: 0, question: 0, message: 0, review: 1, task: 2, failed: 3 };
/** Within a tier: approvals, then questions, then messages. */
const KIND_RANK: Record<AttentionKind, number> = { approval: 0, question: 1, message: 2, review: 3, task: 4, failed: 5 };

const STALE_REASON: Partial<Record<string, AttentionSettled['why']>> = { 'mentioned-work-ended': 'work-ended' };

const PR_MARKER = /\[\[pr:([^\]/\s]+)\/(\d+)\]\]/g;

/** A card's PRs and the projects each can be in: a mention names its project; a declared `{pr}` takes
 *  a mention's project, else the tasks the card is about, else its source task (`aboutPrProjects`). */
function questionPrs(question: QuestionItem): Array<{ number: number; projects: string[]; declared: boolean }> {
  const texts = question.questions.flatMap((entry) => [entry.question, ...entry.options.flatMap((option) => [option.label, option.description ?? ''])]);
  const mentions = texts.flatMap((text) => [...text.matchAll(PR_MARKER)].map((match) => ({ projectId: match[1]!, number: Number(match[2]) })));
  const taskProjects = [
    ...(question.about ?? []).flatMap((ref) => ('task' in ref ? [ref.task.split('/')[0]!] : [])),
    ...(question.sourceTasks ?? []).map((task) => task.projectId),
    ...(question.source.kind === 'task' ? [question.source.projectId] : []),
  ];
  const out = new Map<number, { number: number; projects: Set<string>; declared: boolean }>();
  for (const ref of question.about ?? []) {
    if (!('pr' in ref)) continue;
    const named = mentions.filter((mention) => mention.number === ref.pr).map((mention) => mention.projectId);
    out.set(ref.pr, { number: ref.pr, projects: new Set(named.length > 0 ? named : taskProjects), declared: true });
  }
  for (const mention of mentions) {
    const entry = out.get(mention.number) ?? { number: mention.number, projects: new Set<string>(), declared: false };
    entry.projects.add(mention.projectId);
    out.set(mention.number, entry);
  }
  return [...out.values()].map((entry) => ({ ...entry, projects: [...entry.projects] }));
}

/** The age itself, not the threshold: a task paused 40 days reads "Quiet for 40 days". */
const quiet = (since: string, now: number): AttentionSettled => {
  const days = Math.max(1, Math.floor((now - Date.parse(since)) / DAY_MS));
  return { why: 'quiet', detail: `Quiet for ${days} ${days === 1 ? 'day' : 'days'}` };
};

const TASK_KIND: Partial<Record<string, AttentionKind>> = { 'task-needs-you': 'task', 'task-review': 'review', 'task-failed': 'failed' };

function questionItem(item: QuestionItem, muted: (managerId: string) => boolean, settled: AttentionSettled | undefined): AttentionItem {
  const first = item.questions[0];
  const only = item.questions.length === 1 && first && !first.multiSelect && first.options.length > 0 ? first : undefined;
  const source = item.source;
  return {
    key: `question:${item.key}`,
    kind: 'question',
    title: first?.question ?? 'A question for you',
    ...(item.questions.length > 1 ? { detail: `${item.questions.length} questions` } : {}),
    since: item.askedAt,
    counted: source.kind !== 'manager' || !muted(source.managerId),
    ...(source.kind === 'manager'
      ? { managerId: source.managerId, managerName: source.name }
      : { projectId: source.projectId, runId: source.runId, detail: source.title }),
    questionKey: item.key,
    ...(only ? { options: only.options.map((option) => option.label), header: only.header } : {}),
    ...(settled ? { settled } : {}),
  };
}

export function buildAttentionList(sources: AttentionSources): AttentionResponse {
  const managers = new Map(sources.managers.map((manager) => [manager.id, manager]));
  // A manager whose Notify is off still shows its items; they just do not count (its own switch, B5).
  const muted = (managerId: string) => managers.get(managerId)?.notify === false;
  const items: AttentionItem[] = [];

  const days = sources.olderAfterDays ?? 0;
  const runs = new Map<string, RunRecord>();
  for (const project of sources.projects) for (const run of project.runs) runs.set(`${project.id}/${run.id}`, run);
  const prSettled = (projectId: string | undefined, runId: string | undefined, since: string): AttentionSettled | undefined => {
    const run = projectId && runId ? runs.get(`${projectId}/${runId}`) : undefined;
    const ended = run ? sources.prEnded?.(projectId!, run) : undefined;
    return ended && endedAfter(ended, since) ? { why: ended.state === 'merged' ? 'pr-merged' : 'pr-closed', detail: `PR #${ended.number} ${ended.state}` } : undefined;
  };

  const asked = new Set<string>();
  for (const question of sources.questions) {
    if (question.closed) continue;
    // An inactive manager's cards leave the count, as on the Questions page.
    if (question.source.kind === 'manager' && managers.get(question.source.managerId)?.inactive) continue;
    if (question.source.kind === 'task') asked.add(`${question.source.projectId}/${question.source.runId}`);
    const settled = question.source.kind === 'task' ? prSettled(question.source.projectId, question.source.runId, question.askedAt) : undefined;
    const cardPr = settled ? undefined : questionPrs(question).map((pr) => {
      const ended = pr.projects.map((projectId) => sources.prState?.(projectId, pr.number)).find((found) => endedAfter(found, question.askedAt));
      return ended ? { why: ended.state === 'merged' ? 'pr-merged' as const : 'pr-closed' as const, detail: `PR #${pr.number} ${pr.declared ? '' : 'it mentions was '}${ended.state}` } : undefined;
    }).find((found) => found !== undefined);
    const stale = question.stale ? { why: STALE_REASON[question.stale.why] ?? 'overtaken', detail: question.stale.detail } : undefined;
    items.push(questionItem(question, muted, settled ?? cardPr ?? stale ?? (question.older ? quiet(question.askedAt, sources.now) : undefined)));
  }

  for (const { managerId, message, title } of sources.approvals) {
    const manager = managers.get(managerId);
    items.push({
      key: `approval:${managerId}:${message.id}`,
      kind: 'approval',
      title,
      since: message.at,
      counted: !muted(managerId),
      managerId,
      ...(manager ? { managerName: manager.name } : {}),
      actionId: message.id,
    });
  }

  for (const manager of sources.managers) {
    if (manager.inactive || manager.important <= 0) continue;
    items.push({
      key: `message:${manager.id}:${manager.important}:${manager.headline ?? ''}`,
      kind: 'message',
      title: manager.headline ?? 'Important message',
      ...(manager.important > 1 ? { detail: `${manager.important} important messages` } : {}),
      since: manager.lastActivityAt ?? new Date(sources.now).toISOString(),
      counted: !muted(manager.id),
      managerId: manager.id,
      managerName: manager.name,
    });
  }

  for (const project of sources.projects) {
    for (const row of taskAttention(project.id, [...project.runs], sources.now)) {
      const kind = TASK_KIND[row.kind];
      if (!kind || !row.runId) continue;
      // Its question is already a row of its own.
      if (kind === 'task' && asked.has(`${project.id}/${row.runId}`)) continue;
      const since = row.since ?? new Date(sources.now).toISOString();
      const wentQuiet = kind === 'task' && days > 0 && sources.now - Date.parse(since) > days * DAY_MS;
      const settled = prSettled(project.id, row.runId, since) ?? (wentQuiet ? quiet(since, sources.now) : undefined);
      items.push({
        key: row.key,
        kind,
        title: row.title,
        ...(row.detail ? { detail: row.detail } : {}),
        since,
        counted: kind !== 'failed',
        projectId: project.id,
        runId: row.runId,
        ...(settled ? { settled } : {}),
      });
    }
  }

  const overrides = activeOverrides(sources.overrides ?? [], sources.now);
  const mode = new Map(overrides.map((entry) => [entry.key, entry.mode]));
  // A dismissal also covers its task's items that began before it: when a dismissed question's card
  // closes, the run's wait comes back under another key, and it is the same wait.
  const runDismissals = overrides.filter((entry) => entry.mode === 'dismiss' && entry.projectId && entry.runId);
  const coveredByRun = (item: AttentionItem) => runDismissals.some((entry) =>
    entry.projectId === item.projectId && entry.runId === item.runId && Date.parse(item.since) <= Date.parse(entry.at));
  const shown = items.flatMap((item) => {
    const said = mode.get(item.key);
    if (said === 'dismiss' || (said !== 'keep' && coveredByRun(item))) return [];
    // Probably done is listed and never counted; `counted` keeps what it would be, so "keep" restores it.
    return [item];
  }).map((item) => (mode.get(item.key) === 'keep' && item.settled ? withoutSettled(item) : item));
  // Within a tier, an item past half the quiet threshold sorts below the fresh ones (spec § Order).
  const aging = (item: AttentionItem) => Number(days > 0 && sources.now - Date.parse(item.since) > (days * DAY_MS) / 2);
  shown.sort((a, b) => Number(!!a.settled) - Number(!!b.settled) || TIER[a.kind] - TIER[b.kind] || aging(a) - aging(b)
    || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.since.localeCompare(a.since));
  return { items: shown, counts: countAttention(shown), revision: revisionOf(shown, overrides), overrides, olderAfterDays: days };
}

function withoutSettled(item: AttentionItem): AttentionItem {
  const { settled: _settled, ...rest } = item;
  return rest;
}

export function countAttention(items: readonly AttentionItem[]): AttentionCounts {
  const counts: AttentionCounts = { total: 0, question: 0, approval: 0, task: 0, review: 0, failed: 0, message: 0 };
  for (const item of items) {
    // Probably done: listed apart, in no count.
    if (item.settled) continue;
    counts[item.kind] += 1;
    if (item.counted) counts.total += 1;
  }
  return counts;
}

/** A phone's badge: the kinds it counts, leaving out a muted manager's items. Failed counts only when chosen. */
export function phoneBadgeCount(items: readonly AttentionItem[], kinds: readonly AttentionKind[]): number {
  const chosen = new Set(kinds);
  return items.filter((item) => chosen.has(item.kind) && !item.settled && (item.counted || item.kind === 'failed')).length;
}

const revisionOf = (items: readonly AttentionItem[], overrides: readonly AttentionOverride[]): string =>
  createHash('sha256')
    .update([...items.map((item) => `${item.key}|${item.counted ? 1 : 0}|${item.settled?.why ?? ''}`), ...overrides.map((entry) => `o:${entry.key}|${entry.mode}`)].join('\n'))
    .digest('base64url').slice(0, 22);

/** The task's current PR: the newest it created or declared, else its created URL, else its `CEZ:PR`.
 *  Never a PR it only mentions (`derived`). */
export function currentTaskPr(run: Pick<RunRecord, 'prRefs' | 'pullRequestUrl' | 'markerRefs'>): number | undefined {
  const own = (run.prRefs ?? []).filter((ref) => ref.origin !== 'derived');
  // Newest first; a tie (legacy refs all carry the run's `createdAt`) goes to the store's own rank.
  const newest = own.reduce<(typeof own)[number] | undefined>((best, ref) => {
    if (!best) return ref;
    const delta = Date.parse(ref.at) - Date.parse(best.at);
    return delta > 0 || (delta === 0 && RUN_PR_REF_RANK[ref.origin] < RUN_PR_REF_RANK[best.origin]) ? ref : best;
  }, undefined);
  if (newest) return newest.number;
  const created = run.pullRequestUrl ? Number(/\/(\d+)\/?$/.exec(run.pullRequestUrl.trim())?.[1]) : Number.NaN;
  if (Number.isInteger(created) && created > 0) return created;
  return run.markerRefs?.pr;
}

/** A manager's approvals and questions still waiting: not dismissed, snoozed or probably done. A muted
 *  manager's stay listed here (its Notify switch only takes them out of the badges' counts). */
export function managerNeedsYou(items: readonly AttentionItem[], managerId: string): { approvals: number; questions: number } {
  const live = items.filter((item) => item.managerId === managerId && !item.settled);
  return { approvals: live.filter((item) => item.kind === 'approval').length, questions: live.filter((item) => item.kind === 'question').length };
}


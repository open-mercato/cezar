import { createHash } from 'node:crypto';
import {
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
  /** The task's own pull request, when the forge cache already knows it ended. Never asks the forge. */
  prEnded?: (projectId: string, run: RunRecord) => { number: number; state: 'merged' | 'closed' } | undefined;
  overrides?: readonly AttentionOverride[];
}

const DAY_MS = 24 * 60 * 60_000;

/** Blocking decisions first, then the review gate, then waits, then failures (spec 2026-11-23-needs-you-triage). */
const KIND_RANK: Record<AttentionKind, number> = { approval: 0, question: 1, message: 2, review: 3, task: 4, failed: 5 };

const STALE_REASON: Partial<Record<string, AttentionSettled['why']>> = { 'mentioned-work-ended': 'work-ended' };

const quiet = (days: number): AttentionSettled => ({ why: 'quiet', detail: `Quiet for ${days} ${days === 1 ? 'day' : 'days'}` });

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
  const prSettled = (projectId: string | undefined, runId: string | undefined): AttentionSettled | undefined => {
    const run = projectId && runId ? runs.get(`${projectId}/${runId}`) : undefined;
    const ended = run && sources.prEnded?.(projectId!, run);
    return ended ? { why: ended.state === 'merged' ? 'pr-merged' : 'pr-closed', detail: `PR #${ended.number} ${ended.state}` } : undefined;
  };

  const asked = new Set<string>();
  for (const question of sources.questions) {
    if (question.closed) continue;
    // An inactive manager's cards leave the count, as on the Questions page.
    if (question.source.kind === 'manager' && managers.get(question.source.managerId)?.inactive) continue;
    if (question.source.kind === 'task') asked.add(`${question.source.projectId}/${question.source.runId}`);
    const settled = question.source.kind === 'task' ? prSettled(question.source.projectId, question.source.runId) : undefined;
    const stale = question.stale ? { why: STALE_REASON[question.stale.why] ?? 'overtaken', detail: question.stale.detail } : undefined;
    items.push(questionItem(question, muted, settled ?? stale ?? (question.older ? quiet(days) : undefined)));
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
      const settled = prSettled(project.id, row.runId) ?? (wentQuiet ? quiet(days) : undefined);
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
  const shown = items.flatMap((item) => {
    const said = mode.get(item.key);
    if (said === 'dismiss') return [];
    if (said === 'keep' || !item.settled) return [item];
    // Probably done: still listed, never counted.
    return [{ ...item, counted: false }];
  }).map((item) => (mode.get(item.key) === 'keep' && item.settled ? withoutSettled(item) : item));
  // A dismissal names the task it hid; Now's own task rows have no other way to find it.
  const hid = new Map(items.filter((item) => mode.get(item.key) === 'dismiss' && item.runId).map((item) => [item.key, item]));
  const answered = overrides.map(({ projectId: _p, runId: _r, ...entry }) => {
    const item = hid.get(entry.key);
    return item?.projectId && item.runId ? { ...entry, projectId: item.projectId, runId: item.runId } : entry;
  });
  shown.sort((a, b) => Number(!!a.settled) - Number(!!b.settled) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.since.localeCompare(a.since));
  return { items: shown, counts: countAttention(shown), revision: revisionOf(shown, overrides), overrides: answered };
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

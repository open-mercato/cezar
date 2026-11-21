import { createHash } from 'node:crypto';
import {
  ATTENTION_KINDS,
  type AttentionCounts,
  type AttentionItem,
  type AttentionKind,
  type AttentionResponse,
  type ManagerMessage,
  type ManagerSummary,
  type QuestionItem,
} from '@open-mercato/cezar-contract';
import { taskAttention } from '../managers/snapshot.ts';
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
}

const TASK_KIND: Partial<Record<string, AttentionKind>> = { 'task-needs-you': 'task', 'task-review': 'review', 'task-failed': 'failed' };

function questionItem(item: QuestionItem, muted: (managerId: string) => boolean): AttentionItem {
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
  };
}

export function buildAttentionList(sources: AttentionSources): AttentionResponse {
  const managers = new Map(sources.managers.map((manager) => [manager.id, manager]));
  // A manager whose Notify is off still shows its items; they just do not count (its own switch, B5).
  const muted = (managerId: string) => managers.get(managerId)?.notify === false;
  const items: AttentionItem[] = [];

  const asked = new Set<string>();
  for (const question of sources.questions) {
    if (question.older || question.closed) continue;
    // An inactive manager's cards leave the count, as on the Questions page.
    if (question.source.kind === 'manager' && managers.get(question.source.managerId)?.inactive) continue;
    if (question.source.kind === 'task') asked.add(`${question.source.projectId}/${question.source.runId}`);
    items.push(questionItem(question, muted));
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
      items.push({
        key: row.key,
        kind,
        title: row.title,
        ...(row.detail ? { detail: row.detail } : {}),
        since: row.since ?? new Date(sources.now).toISOString(),
        counted: kind !== 'failed',
        projectId: project.id,
        runId: row.runId,
      });
    }
  }

  items.sort((a, b) => ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind) || b.since.localeCompare(a.since));
  return { items, counts: countAttention(items), revision: revisionOf(items) };
}

export function countAttention(items: readonly AttentionItem[]): AttentionCounts {
  const counts: AttentionCounts = { total: 0, question: 0, approval: 0, task: 0, review: 0, failed: 0, message: 0 };
  for (const item of items) {
    counts[item.kind] += 1;
    if (item.counted) counts.total += 1;
  }
  return counts;
}

/** A phone's badge: the kinds it counts, leaving out a muted manager's items. Failed counts only when chosen. */
export function phoneBadgeCount(items: readonly AttentionItem[], kinds: readonly AttentionKind[]): number {
  const chosen = new Set(kinds);
  return items.filter((item) => chosen.has(item.kind) && (item.counted || item.kind === 'failed')).length;
}

const revisionOf = (items: readonly AttentionItem[]): string =>
  createHash('sha256').update(items.map((item) => `${item.key}|${item.counted ? 1 : 0}`).join('\n')).digest('base64url').slice(0, 22);

import type { AttentionItem, AttentionKind, AttentionOverride, RunRecord } from '@open-mercato/cezar-api-client'

import type { NeedsYouReason } from './now-model'

/**
 * Needs you triage (spec 2026-11-23-needs-you-triage): what a row's ✕ and ⋯ act on, and which rows
 * are probably done. The server decides "probably done"; Now's own task rows borrow its verdict by run.
 */

/** What Dismiss, Snooze and "Still needs me" act on. A question's ✕ also closes its card. */
export interface TriageTarget {
  key: string
  /** The toast's name for it. */
  label: string
  questionKey?: string
  /** Its task: a dismissal covers that run's earlier waits too, so a closed question's wait stays hidden. */
  projectId?: string
  runId?: string
}

export type SnoozeChoice = 'hour' | 'evening' | 'tomorrow' | 'week'

export const SNOOZE_LABEL: Record<SnoozeChoice, string> = {
  hour: 'For 1 hour',
  evening: 'Until this evening',
  tomorrow: 'Until tomorrow morning',
  week: 'Until next week',
}

const EVENING_HOUR = 18
const MORNING_HOUR = 9

/** The local instant a snooze ends. "This evening" past 18:00 is tomorrow evening. */
export function snoozeUntil(choice: SnoozeChoice, now: number): Date {
  const at = new Date(now)
  switch (choice) {
    case 'hour':
      return new Date(now + 60 * 60_000)
    case 'evening': {
      const evening = new Date(at.getFullYear(), at.getMonth(), at.getDate(), EVENING_HOUR)
      if (evening.getTime() <= now) evening.setDate(evening.getDate() + 1)
      return evening
    }
    case 'tomorrow':
      return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, MORNING_HOUR)
    case 'week': {
      // Next Monday morning.
      const days = ((8 - at.getDay()) % 7) || 7
      return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days, MORNING_HOUR)
    }
  }
}

/** The server's item for one of Now's own task rows: same project and run. */
export function itemForRun(items: readonly AttentionItem[] | undefined, projectId: string | undefined, runId: string): AttentionItem | undefined {
  if (!items || projectId === undefined) return undefined
  return items.find((item) => item.projectId === projectId && item.runId === runId)
}

/** A row the server does not list (a lifecycle wait, an older failure) still gets a key: its run and wait. */
export function taskRowTarget(item: AttentionItem | undefined, projectId: string | undefined, run: RunRecord, since: string, label: string): TriageTarget {
  const task = projectId ? { projectId, runId: run.id } : {}
  if (item) return { key: item.key, label, ...(item.questionKey ? { questionKey: item.questionKey } : {}), ...task }
  return { key: `now:${projectId ?? 'default'}:${run.id}:${since}`, label, ...task }
}

export function itemTarget(item: AttentionItem, label = item.title): TriageTarget {
  return {
    key: item.key,
    label,
    ...(item.kind === 'question' && item.questionKey ? { questionKey: item.questionKey } : {}),
    ...(item.projectId && item.runId ? { projectId: item.projectId, runId: item.runId } : {}),
  }
}

/** Dismissed (or snoozed) by key, or a question waiting out its undo window before its card closes. */
export function isHidden(target: TriageTarget, overrides: readonly AttentionOverride[] | undefined, pendingQuestions: ReadonlySet<string>): boolean {
  if (target.questionKey && pendingQuestions.has(target.questionKey)) return true
  return overrides?.some((entry) => entry.key === target.key && entry.mode === 'dismiss') ?? false
}

/** Now's own task row: its item left the list when dismissed, so the dismissal names the run it hid. */
/** The server's rule (`attention/list.ts`): a dismissal covers its run's waits that began before it. */
export function isRunHidden(projectId: string | undefined, runId: string, since: string, overrides: readonly AttentionOverride[] | undefined): boolean {
  if (projectId === undefined) return false
  return overrides?.some((entry) => entry.mode === 'dismiss' && entry.projectId === projectId && entry.runId === runId
    && Date.parse(since) <= Date.parse(entry.at)) ?? false
}

/** The server's tiers and kind ranks (`attention/list.ts`): blocking decisions (approvals, questions,
 *  messages), the review gate, waits, failures. */
export const KIND_TIER: Record<AttentionKind, number> = { approval: 0, question: 0, message: 0, review: 1, task: 2, failed: 3 }
export const KIND_RANK: Record<AttentionKind, number> = { approval: 0, question: 1, message: 2, review: 3, task: 4, failed: 5 }
export const REASON_TIER: Record<NeedsYouReason, number> = { question: 0, review: 1, budget: 2, waiting: 2, lifecycle: 2, failed: 3 }
export const REASON_RANK: Record<NeedsYouReason, number> = { question: 1, review: 3, budget: 4, waiting: 4, lifecycle: 4, failed: 5 }

const DAY_MS = 24 * 60 * 60_000

/** This project's rows, manager items and tasks together, as the server orders its list: by tier,
 *  then a row past half the Older days below the fresh ones of its tier, then by kind, newest first. */
export function orderNeedsYou<T extends { tier: number; rank: number; since: string }>(rows: readonly T[], olderAfterDays: number, now: number): T[] {
  const aging = (row: T) => Number(olderAfterDays > 0 && now - Date.parse(row.since) > (olderAfterDays * DAY_MS) / 2)
  return [...rows].sort((a, b) => a.tier - b.tier || aging(a) - aging(b) || a.rank - b.rank || b.since.localeCompare(a.since))
}

/** Runs override writes one key at a time, in click order: an Undo's clear must never reach the
 *  server before the dismiss it undoes, or the dismissal sticks. A failed write does not block the next. */
export function keyedQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return (key, work) => {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    tails.set(key, next)
    const forget = () => { if (tails.get(key) === next) tails.delete(key) }
    next.then(forget, forget)
    return next
  }
}

/** One line of toast text: a long title would wrap the toast. */
export function shortLabel(text: string, max = 48): string {
  const plain = text.replace(/\[\[(?:task|pr|issue):[^\]/\s]+\/([^\]\s]+)\]\]/g, (_match, id: string) => (/^\d+$/.test(id) ? `#${id}` : 'task')).replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

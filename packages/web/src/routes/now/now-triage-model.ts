import type { AttentionItem, AttentionOverride, RunRecord } from '@open-mercato/cezar-api-client'

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
  if (item) return { key: item.key, label, ...(item.questionKey ? { questionKey: item.questionKey } : {}) }
  return { key: `now:${projectId ?? 'default'}:${run.id}:${since}`, label }
}

export function itemTarget(item: AttentionItem, label = item.title): TriageTarget {
  return { key: item.key, label, ...(item.kind === 'question' && item.questionKey ? { questionKey: item.questionKey } : {}) }
}

/** Dismissed (or snoozed) by key, or a question waiting out its undo window before its card closes. */
export function isHidden(target: TriageTarget, overrides: readonly AttentionOverride[] | undefined, pendingQuestions: ReadonlySet<string>): boolean {
  if (target.questionKey && pendingQuestions.has(target.questionKey)) return true
  return overrides?.some((entry) => entry.key === target.key && entry.mode === 'dismiss') ?? false
}

/** Now's own task row: its item left the list when dismissed, so the dismissal names the run it hid. */
export function isRunHidden(projectId: string | undefined, runId: string, overrides: readonly AttentionOverride[] | undefined): boolean {
  return projectId !== undefined && (overrides?.some((entry) => entry.mode === 'dismiss' && entry.projectId === projectId && entry.runId === runId) ?? false)
}

/** One line of toast text: a long title would wrap the toast. */
export function shortLabel(text: string, max = 48): string {
  const plain = text.replace(/\[\[(?:task|pr|issue):[^\]/\s]+\/([^\]\s]+)\]\]/g, (_match, id: string) => (/^\d+$/.test(id) ? `#${id}` : 'task')).replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

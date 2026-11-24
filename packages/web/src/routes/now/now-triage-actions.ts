import type { AttentionOverride, AttentionOverrideInput, RunRecord } from '@open-mercato/cezar-api-client'
import type { QueryClient } from '@tanstack/react-query'

import { scheduleDismiss } from '@/api/questions'
import type { ToastAction, ToastTone } from '@/components/ui/toaster'
import { runTitle } from '@/lib/task-groups'

import type { TriageActions } from './now-triage'
import { SNOOZE_LABEL, shortLabel, snoozeUntil, type SnoozeChoice, type TriageTarget } from './now-triage-model'

/**
 * What Needs you's ✕, Undo and ⋯ menu do (spec 2026-11-23-needs-you-triage), with every call injected
 * so the wiring is testable without a server. `NowRoute` supplies the real ones.
 */

export interface TriageDeps {
  queryClient: QueryClient
  setOverride: (input: AttentionOverrideInput) => Promise<AttentionOverride[]>
  clearOverride: (key: string) => Promise<AttentionOverride[]>
  /** The local cache moves on the click, before the server answers. */
  applyLocally: (override: { key: string; mode: 'dismiss' | 'keep' | 'clear'; projectId?: string; runId?: string }) => void
  /** The Questions page's delayed card close: scheduled, paused while the toast is held, undone. */
  /** `onFailed` runs wherever the user is by then: Now may have unmounted (review 2, finding 5). */
  scheduleClose: (questionKey: string, label: string, onFailed: (error: string) => void) => void
  holdClose: (questionKey: string, held: boolean) => void
  /** `false`: too late, the close was already sent. */
  undoClose: (questionKey: string) => boolean
  finishRun: (id: string) => Promise<unknown>
  archiveRun: (id: string, archived: boolean) => Promise<unknown>
  setManagerNotify: (id: string, notify: boolean) => Promise<unknown>
  managerMuted: (id: string) => boolean
  /** Opens the Stop confirm; the stop itself runs only after Confirm. */
  confirmCancel: (run: RunRecord) => void
  copy: (text: string) => Promise<void>
  origin: string
  toast: (message: string, opts?: { tone?: ToastTone; action?: ToastAction; durationMs?: number; expected?: boolean; onHold?: (held: boolean) => void }) => unknown
  refreshAttention: () => Promise<unknown>
  refreshRuns: () => Promise<unknown>
  refreshManagers: () => Promise<unknown>
  /** Override writes for one key in click order (`keyedQueue`). */
  inOrder: <T>(key: string, work: () => Promise<T>) => Promise<T>
  now?: () => number
}

/** Now's card close: the Questions page's delayed close, its failure handed back to Needs you so the
 *  row comes back with the reason (review of #2443). One place, so dropping `onFailed` fails a test. */
export function questionCloser(queryClient: QueryClient): TriageDeps['scheduleClose'] {
  return (questionKey, label, onFailed) => scheduleDismiss(queryClient, questionKey, label, { onFailed })
}

/** The card close waits this long; the toast offering its Undo leaves a second earlier, so an Undo
 *  clicked during the toast's exit still lands in time. */
export const UNDO_TOAST_MS = 5_000

const runOf = (target: TriageTarget) => (target.projectId && target.runId ? { projectId: target.projectId, runId: target.runId } : {})

export function createTriageActions(deps: TriageDeps): TriageActions {
  const now = deps.now ?? Date.now
  const failed = (what: string) => (error: unknown) => {
    deps.toast(`${what}: ${error instanceof Error ? error.message : String(error)}`, { tone: 'danger' })
    void deps.refreshAttention()
  }
  const override = (target: TriageTarget, mode: 'dismiss' | 'keep', until?: string) => {
    deps.applyLocally({ key: target.key, mode, ...(mode === 'dismiss' ? runOf(target) : {}) })
    const input: AttentionOverrideInput = { key: target.key, mode, ...(until ? { until } : {}), ...(mode === 'dismiss' ? runOf(target) : {}) }
    return deps.inOrder(target.key, () => deps.setOverride(input)).then(deps.refreshAttention, failed('Could not save that'))
  }
  const undo = (targets: readonly TriageTarget[]) => {
    let late = 0
    for (const target of targets) {
      if (target.questionKey && !deps.undoClose(target.questionKey)) late += 1
      deps.applyLocally({ key: target.key, mode: 'clear' })
      void deps.inOrder(target.key, () => deps.clearOverride(target.key)).then(deps.refreshAttention, failed('Could not undo'))
    }
    if (late > 0) {
      deps.toast(late === 1 ? 'Too late to undo: the question was already closed' : `Too late to undo ${late} questions: they were already closed`, { tone: 'danger', expected: true })
    }
  }
  // A question's ✕ also closes its card (owner decision), after the Questions page's own undo window.
  const dismissAll = (targets: TriageTarget[]) => {
    if (targets.length === 0) return
    const questions = targets.flatMap((target) => (target.questionKey ? [target.questionKey] : []))
    for (const target of targets) {
      if (target.questionKey) {
        // A close that failed shows the card again: its hiding override goes, and the reason is said.
        deps.scheduleClose(target.questionKey, target.label, (error) => {
          deps.applyLocally({ key: target.key, mode: 'clear' })
          void deps.inOrder(target.key, () => deps.clearOverride(target.key)).finally(() => void deps.refreshAttention())
          deps.toast(`Could not close “${target.label}”: ${error}`, { tone: 'danger' })
        })
      }
      void override(target, 'dismiss')
    }
    deps.toast(targets.length === 1 ? `Dismissed “${targets[0]!.label}”` : `Dismissed ${targets.length} items`, {
      durationMs: UNDO_TOAST_MS,
      action: { label: 'Undo', onClick: () => undo(targets) },
      // Reading the toast holds the card close, as the Questions page's own note does.
      ...(questions.length > 0 ? { onHold: (held: boolean) => { for (const key of questions) deps.holdClose(key, held) } } : {}),
    })
  }
  const settleRun = () => Promise.all([deps.refreshRuns(), deps.refreshAttention()])
  return {
    dismiss: (target) => dismissAll([target]),
    dismissAll,
    snooze: (target, choice: SnoozeChoice) => {
      // A snooze hides; it never closes a question.
      const hidden = { key: target.key, label: target.label, ...runOf(target) }
      void override(hidden, 'dismiss', snoozeUntil(choice, now()).toISOString())
      deps.toast(`Snoozed “${target.label}” ${SNOOZE_LABEL[choice].toLowerCase()}`, {
        durationMs: UNDO_TOAST_MS,
        action: { label: 'Undo', onClick: () => undo([hidden]) },
      })
    },
    keep: (target) => void override(target, 'keep'),
    finish: (run) => void deps.finishRun(run.id).then(settleRun, failed('Could not mark it done')),
    archive: (run) => void deps.archiveRun(run.id, true).then(() => {
      void settleRun()
      deps.toast(`Archived “${shortLabel(runTitle(run))}”`, {
        durationMs: UNDO_TOAST_MS,
        action: { label: 'Undo', onClick: () => void deps.archiveRun(run.id, false).then(settleRun, failed('Could not unarchive')) },
      })
    }, failed('Could not archive')),
    cancel: (run) => deps.confirmCancel(run),
    managerMuted: deps.managerMuted,
    mute: (manager, muted) => {
      const set = (notify: boolean) => deps.setManagerNotify(manager.id, notify)
        .then(() => Promise.all([deps.refreshManagers(), deps.refreshAttention()]), failed('Could not change the manager'))
      void set(!muted)
      deps.toast(muted ? `Muted ${manager.name}: its items stay listed, uncounted` : `Unmuted ${manager.name}`, {
        durationMs: UNDO_TOAST_MS,
        action: { label: 'Undo', onClick: () => void set(muted) },
      })
    },
    copyLink: (path) => {
      const url = new URL(path, deps.origin).href
      void deps.copy(url).then(() => deps.toast('Link copied'), () => deps.toast('Could not copy the link', { tone: 'danger', expected: true }))
    },
  }
}

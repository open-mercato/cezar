import { triggerLabel } from '@/lib/automation-format'
import type { RailState } from '@/components/onboarding-kit'

import { needsChangedLabels, sourceOf, type EditorDraft } from './editor-draft'

/**
 * The editor's plain-words readback (spec 2026-10-26-first-run-onboarding § Automations editor):
 * one sentence saying what the form will do, recomputed on every keystroke, so nobody has to
 * assemble it from four sections. And the three-step rail's state, derived from the same draft.
 */

export const PLACEHOLDERS: Record<EditorDraft['kind'], readonly string[]> = {
  schedule: ['{{date}}', '{{project}}'],
  github: ['{{github.url}}', '{{github.title}}', '{{github.number}}', '{{github.author}}', '{{github.labels}}', '{{date}}', '{{project}}'],
  tracker: ['{{tracker.key}}', '{{tracker.title}}', '{{tracker.url}}', '{{tracker.status}}', '{{date}}', '{{project}}'],
}

/** The trigger half, as the list's trigger cell says it. */
export function triggerSentence(draft: EditorDraft): string {
  return triggerLabel({
    kind: draft.kind,
    events: draft.events,
    intervalSeconds: draft.intervalSeconds,
    schedule: draft.schedule,
    ...(draft.trackerTrigger ? { trackerTrigger: draft.trackerTrigger } : {}),
  })
}

/** "Every day at 04:00: quick task on claude, autonomous, up to 4 subtasks." */
export function draftSentence(draft: EditorDraft, dispatchAvailable: boolean): string {
  const trigger = triggerSentence(draft)
  const source = sourceOf(draft)
  const what = source ? `${source.source === 'skill' ? 'skill' : 'workflow'} ${source.ref}` : 'a quick task'
  const parts = [`${what} on ${draft.runner ?? 'the default agent'}${draft.model ? ` (${draft.model})` : ''}`]
  parts.push(draft.autonomous ? 'autonomous' : 'pausing when it needs you')
  if (dispatchAvailable && draft.dispatch) parts.push(`up to ${draft.maxSubtasks} subtasks`)
  const head = trigger.charAt(0).toUpperCase() + trigger.slice(1)
  return `${head}: ${parts.join(', ')}.`
}

/** Whether the When section can be saved as it stands. */
export function triggerComplete(draft: EditorDraft, trackerValid: boolean): boolean {
  if (draft.kind === 'schedule') return true
  if (draft.kind === 'tracker') return trackerValid
  return draft.events.length > 0 && (!needsChangedLabels(draft.events) || draft.filters.changedLabels.trim().length > 0)
}

/** The rail: When → What → Go live, ticked as the form fills in; the first open one is current. */
export function railSteps(draft: EditorDraft, trackerValid: boolean): ReadonlyArray<{ id: string; label: string; state: RailState }> {
  const done = [triggerComplete(draft, trackerValid), draft.prompt.trim().length > 0, draft.name.trim().length > 0]
  const current = done.indexOf(false)
  return [
    { id: 'when', label: 'When' },
    { id: 'what', label: 'What' },
    { id: 'live', label: 'Go live' },
  ].map((step, at) => ({ ...step, state: done[at] && (current === -1 || at < current) ? 'done' : at === current || (current === -1 && at === 2) ? 'current' : 'next' }))
}

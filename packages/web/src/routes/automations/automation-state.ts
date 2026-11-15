import type { AutomationListEntry, RunStatus } from '@open-mercato/cezar-api-client'

import type { StatusDotTone } from '@/components/status-dot'
import { deriveAttention, type Attention } from '@/lib/attention'

/**
 * The two state vocabularies the Automations screens show, each from ONE place (redesign
 * 2026-11, "never pick a status colour by hand"):
 *  - a RUN's state (last run, recent runs, log children) goes through `deriveAttention`, the
 *    same function the task list and the thread use, so an automation's task never wears a
 *    colour its own thread would not;
 *  - an AUTOMATION's own state is not a run — it rests, watches or is paused — and has its own
 *    three-tone grammar below.
 */

/** A run status → dot tone, pulse and the word beside it, via the canonical attention function. */
export function runAttention(status: RunStatus): Attention {
  return deriveAttention({ status })
}

export interface AutomationState {
  tone: StatusDotTone
  pulse: boolean
  label: string
}

/**
 * Enabled schedule → green, still (armed, nothing to do until it fires); enabled poll → amber,
 * pulsing (it is WATCHING — the status grammar's `pending`, the same dot the stats strip and
 * the Next runs rail give the polls); paused, or a GitHub poll with no forge → neutral.
 */
export function automationState(
  automation: Pick<AutomationListEntry, 'kind' | 'enabled'>,
  /** The forge's availability — a GitHub row is "paused by capability" without it. */
  available = true,
): AutomationState {
  if (automation.kind === 'github' && !available) return { tone: 'neutral', pulse: false, label: 'paused by capability' }
  if (!automation.enabled) return { tone: 'neutral', pulse: false, label: 'paused' }
  if (automation.kind !== 'schedule') return { tone: 'pending', pulse: true, label: 'enabled' }
  return { tone: 'success', pulse: false, label: 'enabled' }
}

/** The header's scheduler word: armed → green, idle → grey. */
export function schedulerState(state: 'scheduled' | 'idle'): AutomationState {
  return state === 'scheduled'
    ? { tone: 'success', pulse: false, label: 'Scheduler running' }
    : { tone: 'neutral', pulse: false, label: 'Scheduler idle' }
}

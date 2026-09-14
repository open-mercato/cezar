import type { AutomationDispatch, AutomationEvent, AutomationSchedule } from '@open-mercato/cezar-api-client'

/**
 * The editor's built-in automation templates (spec 2026-09-14-automations-redesign § UI/UX 4,
 * from the design's `data.js`): six starting points that fill the whole form. They ship in code
 * — nothing to configure, nothing persisted — and cost nothing on a cockpit that never opens
 * the palette. None names a workflow: the cockpit's default (`quick-task`) is the one workflow
 * every repo has, and a template that named another would launch into "unknown workflow" on a
 * repo without it.
 */
export interface AutomationTemplateDraft {
  name: string
  /** The palette card's second line: `Every day at 04:00`, `On issue.opened · every 5 min`. */
  when: string
  kind: 'github' | 'schedule'
  schedule?: AutomationSchedule
  events?: AutomationEvent[]
  intervalSeconds?: number
  prompt: string
  workflow?: string
  dispatch?: AutomationDispatch
}

export const BUILTIN_AUTOMATION_TEMPLATES: readonly AutomationTemplateDraft[] = [
  {
    name: 'Nightly dependency bump',
    when: 'Every day at 04:00',
    kind: 'schedule',
    schedule: { type: 'daily', hour: 4, minute: 0 },
    prompt: 'Run npm outdated, bump patch and minor versions, run the test suite, open a draft PR if anything changed.',
  },
  {
    name: 'Triage new issues',
    when: 'On issue.opened · every 5 min',
    kind: 'github',
    events: ['issue.opened'],
    intervalSeconds: 300,
    prompt: 'Read {{github.url}}. Label it, add a repro or a clarification request. Never close it.',
  },
  {
    name: 'Weekly changelog draft',
    when: 'Fridays at 16:00',
    kind: 'schedule',
    schedule: { type: 'weekly', day: 5, hour: 16, minute: 0 },
    prompt: 'Collect merged PRs since last week, write CHANGELOG entries, open a draft PR.',
  },
  {
    name: 'Stale PR nudge',
    when: 'Every 6 hours',
    kind: 'schedule',
    schedule: { type: 'hours', every: 6 },
    prompt: 'Comment on PRs idle for 48h with what is blocking them.',
  },
  {
    name: 'Flaky test hunt',
    when: 'Tuesdays at 02:00',
    kind: 'schedule',
    schedule: { type: 'weekly', day: 2, hour: 2, minute: 0 },
    prompt: 'Run the suite 5×, quarantine intermittent tests, open an issue per test.',
    dispatch: { maxSubtasks: 8, reviewChild: true },
  },
  {
    name: 'Security advisories',
    when: 'Every day at 06:00',
    kind: 'schedule',
    schedule: { type: 'daily', hour: 6, minute: 0 },
    prompt: 'Run npm audit; for each high/critical advisory open a task with the upgrade path.',
  },
]

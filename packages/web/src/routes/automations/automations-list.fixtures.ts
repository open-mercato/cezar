import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'
import { vi } from 'vitest'

import type { AutomationActions } from './use-automations'

/**
 * Test fixtures for the Automations list, rail and calendars — the kit's `data.js` sample
 * (`.ai/specs/assets/automations-redesign/kit/data.js`) re-expressed on the wire contract, in
 * UTC so every computed position is deterministic. The clock is the demo's: Wed 16 Sep 2026,
 * 10:24 — the week Mon 14 → Sun 20.
 */

export const NOW = Date.parse('2026-09-16T10:24:00.000Z')
export const TIME_ZONE = 'UTC'

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR

export function entry(overrides: Partial<AutomationListEntry> & Pick<AutomationListEntry, 'id' | 'name' | 'kind'>): AutomationListEntry {
  return {
    revision: 1,
    enabled: true,
    task: { prompt: 'Do the thing.', workflow: 'quick-task', runner: 'claude', autonomous: true },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 },
    runs7d: 0,
    ...overrides,
  }
}

export const NIGHTLY = entry({
  id: 'a1',
  name: 'Nightly dependency bump',
  kind: 'schedule',
  schedule: { type: 'daily', hour: 4, minute: 0 },
  task: {
    prompt: 'Run npm outdated, bump patch and minor versions, run the test suite, open a draft PR.',
    workflow: 'fix-and-verify',
    runner: 'claude',
    autonomous: true,
    dispatch: { maxSubtasks: 4, reviewChild: true },
  },
  nextRunAt: '2026-09-17T04:00:00.000Z',
  lastRun: { runId: 't15', status: 'done', ts: iso(6 * HOUR), costUsd: 0.33 },
  runs7d: 7,
  costUsd7d: 2.41,
})

export const TRIAGE = entry({
  id: 'a2',
  name: 'Triage new issues',
  kind: 'github',
  events: ['issue.opened'],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Read {{github.url}}. Label it.', workflow: 'quick-task', runner: 'claude', autonomous: true },
  lastRun: { runId: 't10', status: 'done', ts: iso(41 * 60_000), costUsd: 0.08 },
  runs7d: 19,
  costUsd7d: 1.52,
})

export const CI_SWEEP = entry({
  id: 'a3',
  name: 'Weekday morning CI sweep',
  kind: 'schedule',
  schedule: { type: 'weekdays', hour: 7, minute: 30 },
  task: {
    prompt: 'List workflows that failed on main since yesterday 07:30.',
    workflow: 'quick-task',
    runner: 'codex',
    autonomous: true,
    dispatch: { maxSubtasks: 6, reviewChild: false },
  },
  lastRun: { runId: 't13', status: 'failed', ts: iso(3 * HOUR), costUsd: 0.61 },
  runs7d: 5,
  costUsd7d: 2.9,
})

export const STALE_PR = entry({
  id: 'a4',
  name: 'Stale PR nudge',
  kind: 'schedule',
  schedule: { type: 'hours', every: 6 },
  task: { prompt: 'For every open PR with no activity in 48h, post a short comment.', workflow: 'quick-task', runner: 'claude', autonomous: true },
  lastRun: { runId: 't11', status: 'done', ts: iso(4 * HOUR), costUsd: 0.12 },
  runs7d: 28,
  costUsd7d: 3.08,
})

export const CHANGELOG = entry({
  id: 'a5',
  name: 'Weekly changelog draft',
  kind: 'schedule',
  schedule: { type: 'weekly', day: 5, hour: 16, minute: 0 },
  task: { prompt: 'Collect merged PRs since last Friday 16:00.', workflow: 'fix-and-verify', runner: 'claude', autonomous: false },
  lastRun: { runId: 't12', status: 'done', ts: iso(5 * DAY), costUsd: 1.12 },
  runs7d: 1,
  costUsd7d: 1.12,
})

export const FLAKY = entry({
  id: 'a6',
  name: 'Flaky test hunt',
  kind: 'schedule',
  enabled: false,
  schedule: { type: 'weekly', day: 2, hour: 2, minute: 0 },
  task: {
    prompt: 'Run the unit suite 5×. Quarantine any flaky test.',
    workflow: 'fix-and-verify',
    runner: 'claude',
    autonomous: true,
    dispatch: { maxSubtasks: 8, reviewChild: true },
  },
  lastRun: { runId: 't14', status: 'done', ts: iso(8 * DAY), costUsd: 2.7 },
  runs7d: 0,
})

export const REVIEW_PRS = entry({
  id: 'a7',
  name: 'Review open PRs',
  kind: 'github',
  events: ['pull_request.opened'],
  intervalSeconds: 600,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}} for real issues only.', workflow: 'quick-task', runner: 'claude', autonomous: true },
  lastRun: { runId: 't2', status: 'review', ts: iso(52 * 60_000), costUsd: 0.62 },
  runs7d: 6,
  costUsd7d: 2.35,
})

export const AUTOMATIONS: AutomationListEntry[] = [NIGHTLY, TRIAGE, CI_SWEEP, STALE_PR, CHANGELOG, FLAKY, REVIEW_PRS]

export function response(overrides: Partial<AutomationsResponse> = {}): AutomationsResponse {
  return {
    available: true,
    scheduler: { state: 'scheduled' },
    timeZone: TIME_ZONE,
    stats: { runs: 66, failed: 2, agentSeconds: 4 * 3600 + 12 * 60, costUsd: 13.4 },
    automations: AUTOMATIONS,
    ...overrides,
  }
}

/** Every action a resolved spy, so a test can assert what a click asked for. */
export function mockActions(overrides: Partial<AutomationActions> = {}): AutomationActions {
  return {
    runNow: vi.fn(() => Promise.resolve()),
    toggleEnabled: vi.fn(() => Promise.resolve()),
    duplicate: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    copyCli: vi.fn(() => Promise.resolve()),
    busy: false,
    ...overrides,
  }
}

/** jsdom ships no ResizeObserver; Radix positions menus with floating-ui, which observes the trigger. */
export function stubResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
}

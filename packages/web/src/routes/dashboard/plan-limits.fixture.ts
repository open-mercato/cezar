import type { PlanUsageConsumer, PlanUsageReport, PlanUsageWindow } from '@open-mercato/cezar-api-client'

export const consumer = (over: Partial<PlanUsageConsumer> & Pick<PlanUsageConsumer, 'id' | 'title' | 'estimatePp'>): PlanUsageConsumer => ({
  kind: 'task',
  aloneInferredPp: 0,
  sharedEstimatePp: over.estimatePp,
  retryWasteEstimatePp: 0,
  ranTogetherWith: { tasks: 0, managers: 0, internal: 0 },
  evidence: 'account-level',
  ...over,
})

export function planWindow(over: Partial<PlanUsageWindow> = {}): PlanUsageWindow {
  return {
    id: 'claude:default|five-hour|2026-11-19T15:00:00.000Z',
    account: { key: 'claude:default', provider: 'claude', accountId: 'default', label: 'Claude · default' },
    kind: 'five-hour',
    startsAt: '2026-11-19T10:00:00.000Z',
    resetsAt: '2026-11-19T15:00:00.000Z',
    current: true,
    usedPercent: { first: 5, last: 100 },
    limitReachedAt: '2026-11-19T14:20:00.000Z',
    readings: [
      { at: '2026-11-19T10:05:00.000Z', usedPercent: 5, status: 'allowed', source: 'claude-stream' },
      { at: '2026-11-19T12:00:00.000Z', usedPercent: 50, status: 'allowed', source: 'claude-stream' },
      { at: '2026-11-19T14:20:00.000Z', usedPercent: 100, status: 'blocked', source: 'claude-stream' },
    ],
    consumers: [
      consumer({ id: 'run:shop/r1', title: 'Retry temp-repo removal', projectId: 'shop', runId: 'r1', estimatePp: 25, aloneInferredPp: 4, retryWasteEstimatePp: 11, ranTogetherWith: { tasks: 3, managers: 0, internal: 0 } }),
      consumer({ id: 'run:shop/r2', title: 'Drop waiting dot', projectId: 'shop', runId: 'r2', estimatePp: 53, ranTogetherWith: { tasks: 3, managers: 1, internal: 0 } }),
      consumer({ id: 'mgr:m1', kind: 'manager', title: 'Release manager', managerId: 'm1', estimatePp: 5, parts: { chat: 4, watch: 0.6, job: 0.4 }, ranTogetherWith: { tasks: 2, managers: 0, internal: 0 } }),
    ],
    beforeTrackingPp: 0,
    outsideCezarPp: 9,
    unsplitPp: 8,
    correctionPp: 0,
    untrackedPp: 0,
    trackingGaps: [],
    leftPp: 0,
    ...over,
  }
}

export function planReport(windows: PlanUsageWindow[], over: Partial<PlanUsageReport> = {}): PlanUsageReport {
  return {
    schema: 'cezar.usage-ledger',
    version: '1.0.0',
    generatedAt: '2026-11-19T14:30:00.000Z',
    tracking: { enabled: true, retentionDays: 90, accounts: {} },
    accounts: windows.map((w) => w.account),
    windows,
    hints: [],
    ...over,
  }
}

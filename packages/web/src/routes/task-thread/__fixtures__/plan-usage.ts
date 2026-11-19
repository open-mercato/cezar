import type { PlanUsageConsumerWindow } from '@open-mercato/cezar-api-client'

const account = { key: 'claude:default', provider: 'claude' as const, accountId: 'default', label: 'Claude · default' }

/** One consumer window for plan-limit UI tests (task chip, Tasks list column). */
export function planEntry(
  runId: string,
  resetsAt: string,
  consumer: Partial<PlanUsageConsumerWindow['consumer']> = {},
  extra: Partial<PlanUsageConsumerWindow> = {},
): PlanUsageConsumerWindow {
  const resets = Date.parse(resetsAt)
  return {
    windowId: `claude:default:five-hour:${resetsAt}`,
    account,
    kind: 'five-hour',
    startsAt: new Date(resets - 5 * 3_600_000).toISOString(),
    resetsAt,
    current: false,
    consumer: {
      id: `run:p/${runId}`,
      kind: 'task',
      title: runId,
      projectId: 'p',
      runId,
      estimatePp: 25,
      aloneInferredPp: 4,
      sharedEstimatePp: 21,
      retryWasteEstimatePp: 0,
      ranTogetherWith: { tasks: 2, managers: 0, internal: 0 },
      evidence: 'account-level',
      ...consumer,
    },
    ...extra,
  }
}

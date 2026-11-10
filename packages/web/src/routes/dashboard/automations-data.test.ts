import { expect, it } from 'vitest'
import { enabledAutomations, nextAutomationAt } from './automations-data'
import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'
const a = (id: string, extra = {}) =>
  ({ id, name: id, enabled: true, kind: 'schedule', ...extra }) as AutomationListEntry
it('orders enabled automation deadlines across projects, leaving unarmed entries last', () => {
  const rows = enabledAutomations([
    {
      id: 'a',
      name: 'A',
      data: {
        automations: [
          a('paused', { enabled: false }),
          a('unknown'),
          a('later', { nextRunAt: '2026-09-20T10:00:00Z' }),
        ],
      } as AutomationsResponse,
    },
    {
      id: 'b',
      name: 'B',
      data: {
        automations: [a('poll', { kind: 'github', nextRunAt: '2026-09-20T09:00:00Z' })],
      } as AutomationsResponse,
    },
  ])
  expect(rows.map((r) => r.automation.id)).toEqual(['poll', 'later', 'unknown'])
})
it('uses a backoff deadline and never invents a date for unarmed automations', () => {
  expect(
    nextAutomationAt(
      a('retry', {
        nextRunAt: '2026-09-20T09:00:00Z',
        state: { backoffUntil: '2026-09-20T10:00:00Z' },
      }),
    ),
  ).toBe(Date.parse('2026-09-20T10:00:00Z'))
  expect(nextAutomationAt(a('missing'))).toBeNull()
})

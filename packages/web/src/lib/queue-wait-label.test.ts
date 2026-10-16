import { expect, it } from 'vitest'
import { queueWaitLabel } from './queue-wait-label'

const reason = { kind: 'usage-reset' as const, until: '2099-01-01T17:30:00Z' }

it('names the server time zone when it is known', () => {
  expect(queueWaitLabel(reason, 'Europe/Warsaw')).toBe('Waiting for usage limit reset · 18:30 · Europe/Warsaw')
})

it('names the browser zone when the server zone is unknown', () => {
  const label = queueWaitLabel(reason)!
  const zone = new Date(reason.until).toLocaleTimeString([], { timeZoneName: 'short' }).split(' ').pop()!
  expect(label.endsWith(zone)).toBe(true)
})

it('keeps the account-resume wording and passes no reason through', () => {
  expect(queueWaitLabel({ kind: 'account-resume' })).toBe("Waiting for this account's automatic resume")
  expect(queueWaitLabel(undefined)).toBeUndefined()
})

it('uses the server zone carried with a reset reason at both default call sites', () => {
  expect(queueWaitLabel({ ...reason, timeZone: 'Europe/Warsaw' })).toBe('Waiting for usage limit reset · 18:30 · Europe/Warsaw')
})

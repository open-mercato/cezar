import { DEFAULT_PHONE_PUSH_PREFS } from '@open-mercato/cezar-api-client'
import type { PhonesResponse, RelayStatus } from '@open-mercato/cezar-api-client'
import { describe, expect, it } from 'vitest'

import { phoneIconState } from './relay-status'

const PHONE: PhonesResponse['phones'][number] = { deviceId: 'd'.repeat(22), label: 'Pixel', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'android', addedAt: '', connected: true }
const data = (relay: PhonesResponse['relay'], paired = true): PhonesResponse =>
  ({ relayOrigin: 'https://rome.cezar.run', relay, pairing: null, account: { attached: true, computerName: 'Mac' }, keepAwake: { enabled: true, active: true }, phones: paired ? [PHONE] : [] }) as PhonesResponse
const look = (relay: PhonesResponse['relay'], paired = true) => {
  const state = phoneIconState(data(relay, paired))
  return [state.icon, state.dot, state.summary]
}

describe('phoneIconState: green icon when all is well, a dot only when action is needed', () => {
  it.each<[string, PhonesResponse['relay'], boolean, (string | null)[]]>([
    ['connected with a phone', { status: 'connected' }, true, ['ok', null, 'Connected']],
    ['connected, no phone (a removal still owed)', { status: 'connected' }, false, ['neutral', null, 'No phone paired']],
    ['not set up', { status: 'off' }, false, ['neutral', null, 'Not set up']],
    ['paired but no socket yet', { status: 'off' }, true, ['neutral', null, 'Not connected']],
    ['connecting', { status: 'connecting' }, true, ['neutral', 'pending', 'Connecting']],
    ['reconnecting', { status: 'unreachable', attempt: 2 }, true, ['neutral', 'pending', 'Reconnecting']],
    ['degraded: rate-limited', { status: 'rate-limited' }, true, ['neutral', 'pending', 'Degraded']],
    ['degraded: replaced', { status: 'replaced' }, true, ['neutral', 'pending', 'Degraded']],
    ['offline after the quick retries', { status: 'unreachable', attempt: 4 }, true, ['neutral', 'danger', 'Offline']],
    ['offline: quota', { status: 'quota' }, true, ['neutral', 'danger', 'Offline']],
    ['offline: locked keychain', { status: 'locked' }, true, ['neutral', 'danger', 'Offline']],
    ['blocked: email unconfirmed', { status: 'email-unconfirmed' }, true, ['neutral', 'danger', 'Confirm your email']],
    ['blocked: no account', { status: 'account-required' }, true, ['neutral', 'danger', 'Email needed']],
    ['blocked: suspended', { status: 'suspended' }, true, ['neutral', 'danger', 'Suspended']],
  ])('%s', (_name, relay, paired, expected) => {
    expect(look(relay, paired)).toEqual(expected)
  })

  it('maps every relay status (a new one cannot slip through as green)', () => {
    const all: RelayStatus[] = ['off', 'connecting', 'connected', 'unreachable', 'replaced', 'rate-limited', 'quota', 'disabled', 'update-required', 'locked', 'error', 'email-unconfirmed', 'account-required', 'suspended']
    for (const status of all) {
      const state = phoneIconState(data({ status }))
      expect(state.icon === 'ok').toBe(status === 'connected')
      expect(state.dot === null).toBe(status === 'connected' || status === 'off')
      expect(state.text.length).toBeGreaterThan(0)
    }
  })

  it('unknown data reads as not set up', () => {
    expect(phoneIconState(undefined)).toMatchObject({ icon: 'neutral', dot: null, summary: 'Not set up' })
  })
})

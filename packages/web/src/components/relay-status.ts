import type { PhonesResponse } from '@open-mercato/cezar-api-client'

import type { StatusDotTone } from '@/components/status-dot'

/**
 * The phone relay at a glance, for the sidebar's phone entry: read from cezar's own memory of its
 * socket (`GET /workspace/phones`), which the `phone-pairing` event refreshes. Never asks the relay.
 */
export interface RelayIndicator {
  tone: Extract<StatusDotTone, 'success' | 'pending' | 'danger'>
  pulse: boolean
  text: string
  /** The account gate holds the phones: Settings > Connect a phone is where to fix it. */
  blocked: boolean
}

/** Past this many quick retries a lost relay reads as offline rather than reconnecting. */
export const RECONNECTING_ATTEMPTS = 3

const BLOCKED: Partial<Record<PhonesResponse['relay']['status'], string>> = {
  'email-unconfirmed': 'Phones blocked: confirm your email',
  'account-required': 'Phones blocked: add your email and accept the terms',
  suspended: 'Phones blocked: this computer’s relay access is suspended',
}

/** Still retrying on its own soon: amber, not red. */
const DEGRADED = new Set<PhonesResponse['relay']['status']>(['rate-limited', 'replaced'])

const OFFLINE: Partial<Record<PhonesResponse['relay']['status'], string>> = {
  replaced: 'another cezar on this computer holds the connection',
  'rate-limited': 'too many connections, retrying soon',
  quota: 'too much traffic today, retrying later',
  disabled: 'switched off by its operator, retrying later',
  'update-required': 'update cezar to keep using it',
  locked: 'the keychain is locked',
  error: 'stopped',
}

/** A clock time, not a countdown: a tooltip read a minute later must still be true. */
export const nextTry = (relay: PhonesResponse['relay']): string =>
  relay.nextRetryAt ? `, next try at ${new Date(relay.nextRetryAt).toLocaleTimeString()}` : ''

const lastReason = (relay: PhonesResponse['relay']): string =>
  relay.lastDown ? `${relay.lastDown.reason}${relay.lastDown.code !== undefined ? ` ${relay.lastDown.code}` : ''}` : 'no answer'

/** `null` when there is nothing to say: pairing off, or no phone paired and so no socket. */
export function relayIndicator(data: PhonesResponse | undefined): RelayIndicator | null {
  if (!data || data.relay.status === 'off') return null
  const { relay } = data
  const attempt = relay.attempt ?? 0
  const blocked = BLOCKED[relay.status]
  if (blocked) return { tone: 'danger', pulse: false, text: `${blocked}. Open Settings › Connect a phone.`, blocked: true }
  if (relay.status === 'connected') return { tone: 'success', pulse: false, text: 'Phone relay: connected', blocked: false }
  if (relay.status === 'connecting' || (relay.status === 'unreachable' && attempt <= RECONNECTING_ATTEMPTS)) {
    const text = attempt > 0 ? `Reconnecting to the phone relay (attempt ${attempt}${nextTry(relay)})` : 'Connecting to the phone relay'
    return { tone: 'pending', pulse: true, text, blocked: false }
  }
  if (relay.status === 'unreachable') {
    return { tone: 'danger', pulse: false, text: `Can’t reach the phone relay (${lastReason(relay)}): attempt ${attempt}${nextTry(relay)}`, blocked: false }
  }
  const why = `${OFFLINE[relay.status] ?? relay.status}${relay.detail ? ` (${relay.detail})` : ''}`
  if (DEGRADED.has(relay.status)) return { tone: 'pending', pulse: false, text: `Phone relay degraded: ${why}`, blocked: false }
  return { tone: 'danger', pulse: false, text: `Phone relay offline: ${why}`, blocked: false }
}

/**
 * The phone entry's look. All well (relay up, a phone paired): the icon itself is green and carries
 * no dot. A dot means something needs the user: amber while it recovers, red when it will not.
 */
export interface PhoneIconState {
  icon: 'ok' | 'neutral'
  dot: 'pending' | 'danger' | null
  pulse: boolean
  /** The popover header's status in a word or two. */
  summary: string
  /** The tooltip and accessible label, after `Phones · `. */
  text: string
  blocked: boolean
}

const BLOCKED_SUMMARY: Partial<Record<PhonesResponse['relay']['status'], string>> = {
  'email-unconfirmed': 'Confirm your email',
  'account-required': 'Email needed',
  suspended: 'Suspended',
}

export function phoneIconState(data: PhonesResponse | undefined): PhoneIconState {
  const paired = (data?.phones.length ?? 0) > 0
  const indicator = relayIndicator(data)
  if (!indicator) {
    const text = paired ? 'Not connected to the phone relay' : 'Not set up'
    return { icon: 'neutral', dot: null, pulse: false, summary: paired ? 'Not connected' : 'Not set up', text, blocked: false }
  }
  if (indicator.tone === 'success') {
    // Connected with no phone is only a removal still owed to the relay: nothing to celebrate.
    return paired
      ? { icon: 'ok', dot: null, pulse: false, summary: 'Connected', text: indicator.text, blocked: false }
      : { icon: 'neutral', dot: null, pulse: false, summary: 'No phone paired', text: 'No phone paired', blocked: false }
  }
  const status = data!.relay.status
  const summary = indicator.blocked
    ? BLOCKED_SUMMARY[status] ?? 'Blocked'
    : indicator.tone === 'pending'
      ? (DEGRADED.has(status) ? 'Degraded' : (data!.relay.attempt ?? 0) > 0 ? 'Reconnecting' : 'Connecting')
      : 'Offline'
  return { icon: 'neutral', dot: indicator.tone, pulse: indicator.pulse, summary, text: indicator.text, blocked: indicator.blocked }
}

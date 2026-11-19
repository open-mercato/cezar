import type { PhonesResponse, RelayAccountState, RelayKeepAwake, RelayStatus } from '@open-mercato/cezar-api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { phoneKeys, setRelayKeepAwake } from '@/api/phones'
import { relayIndicator } from '@/components/relay-status'
import { StatusDot } from '@/components/status-dot'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

export const RELAY_STATUS: Record<RelayStatus, string> = {
  off: 'not connected, because no phone is paired',
  connecting: 'connecting',
  connected: 'connected',
  unreachable: 'unreachable. Retrying',
  replaced: 'another cezar on this computer holds the connection',
  'rate-limited': 'too many connections. Retrying soon',
  quota: 'too much traffic today. Retrying later',
  disabled: 'switched off by its operator. Retrying later',
  'update-required': 'update cezar to keep using it',
  locked: 'the keychain is locked',
  error: 'stopped',
  'email-unconfirmed': 'not connecting your phones until you confirm your email',
  'account-required': 'not connecting your phones until you enter your email below',
  suspended: 'suspended by Open Mercato, so your phones cannot connect',
}

const UNAVAILABLE: Record<NonNullable<RelayKeepAwake['unavailable']>, string> = {
  'not-macos': 'Only on macOS.',
  'switched-off': 'Switched off by CEZ_RELAY_KEEP_AWAKE=0.',
  'dry-run': 'Off in dry-run mode.',
  missing: 'This Mac has no caffeinate command, so cezar cannot keep it awake.',
}

const ACCOUNT_STATE: Record<RelayAccountState, string> = {
  confirmed: 'confirmed',
  pending: 'waiting for you to confirm your email',
  blocked: 'blocked until you confirm your email',
}

const when = (iso: string) => new Date(iso).toLocaleString()
const host = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function keepAwakeLine(keepAwake: RelayKeepAwake, paired: boolean): string {
  if (keepAwake.unavailable) return UNAVAILABLE[keepAwake.unavailable]
  if (!keepAwake.enabled) return 'Off: this computer may sleep when idle, and your phone cannot reach it then.'
  if (keepAwake.active) return 'On: idle sleep is held off while a phone is paired. The display still sleeps.'
  return paired ? 'On, starting…' : 'On once a phone is paired.'
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-36 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/**
 * The top of Settings > Connect a phone: what cezar knows of its relay socket, enough to tell why a
 * phone cannot reach this computer. All of it is cezar's own memory; nothing here asks the relay.
 */
export function RelayStatusPanel({ data, accountState }: { data: PhonesResponse; accountState?: RelayAccountState }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setRelayKeepAwake(enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: phoneKeys.list }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const { relay, keepAwake, account } = data
  const indicator = relayIndicator(data)
  const paired = data.phones.length > 0
  const enabled = toggle.isPending && toggle.variables !== undefined ? toggle.variables : keepAwake.enabled
  return (
    <section aria-labelledby="relay-status" data-slot="relay-status" className="space-y-3">
      <h2 id="relay-status" className="flex items-center gap-2 text-sm font-medium">
        {indicator ? <StatusDot tone={indicator.tone} pulse={indicator.pulse} aria-hidden="true" /> : null}
        Relay: {RELAY_STATUS[relay.status]}
      </h2>
      <dl className="space-y-1 text-sm">
        <Row label="Relay">{host(data.relayOrigin)}</Row>
        {relay.connectedAt ? <Row label="Connected since">{when(relay.connectedAt)}</Row> : null}
        {relay.lastDown ? (
          <Row label="Last disconnect">
            {when(relay.lastDown.at)} · {relay.lastDown.reason}{relay.lastDown.code !== undefined ? ` (code ${relay.lastDown.code})` : ''}
          </Row>
        ) : null}
        {relay.attempt || relay.nextRetryAt ? (
          <Row label="Reconnecting">
            {relay.attempt ? `attempt ${relay.attempt}` : 'waiting'}
            {relay.nextRetryAt ? `, next try at ${new Date(relay.nextRetryAt).toLocaleTimeString()}` : ''}
          </Row>
        ) : null}
        {relay.detail ? <Row label="Detail">{relay.detail}</Row> : null}
        <Row label="Account">
          {account.attached ? `attached${account.email ? ` (${account.email})` : ''}` : 'not attached'}
          {accountState ? ` · ${ACCOUNT_STATE[accountState]}` : ''}
        </Row>
        {relay.lastBlock ? (
          <Row label="Last blocked">{when(relay.lastBlock.at)} · {relay.lastBlock.reason} (code 4451)</Row>
        ) : null}
      </dl>
      {keepAwake.unavailable === 'not-macos' ? null : (
        <div className="flex items-start justify-between gap-4" data-slot="keep-awake">
          <div>
            <label htmlFor="relay-keep-awake" className="text-sm font-medium">Keep this computer awake for your phone</label>
            <p className="text-ui text-muted-foreground">
              Stops this Mac from sleeping when idle while a phone is paired, so your phone can still reach it with the screen
              locked. On a laptop running on battery this drains it faster.
            </p>
            <p className="text-ui text-muted-foreground" data-testid="keep-awake-state">{keepAwakeLine(keepAwake, paired)}</p>
          </div>
          <Switch
            id="relay-keep-awake"
            checked={enabled}
            disabled={keepAwake.unavailable !== undefined || toggle.isPending}
            onCheckedChange={(next) => toggle.mutate(next)}
          />
        </div>
      )}
    </section>
  )
}

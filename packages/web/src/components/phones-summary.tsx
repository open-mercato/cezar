import type { PhonesResponse, RelayAccountResponse } from '@open-mercato/cezar-api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PencilIcon, PlusIcon, RefreshCwIcon, SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { phoneKeys, reconnectRelay, setRelayKeepAwake } from '@/api/phones'
import type { PhoneIconState } from '@/components/relay-status'
import { StatusDot } from '@/components/status-dot'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'

/** Settings > Connect a phone (spec 2026-11-01-relay-qr-pairing). */
export const CONNECT_PHONE_HREF = '/settings/global/phones'

/** More than this and the list says how many it left out. */
export const PHONES_SHOWN = 3

export type AccountWord = 'confirmed' | 'pending' | 'not confirmed' | 'handover' | 'suspended' | 'no email' | 'added'

/** `j•••@example.com`: enough to recognise, not enough to read off a shared screen. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 1 ? '•••' : `${email[0]}•••@${email.slice(at + 1)}`
}

/** The relay's 4451 state wins; otherwise whatever Settings last read, never a fresh call. */
export function accountWord(data: PhonesResponse, cached: RelayAccountResponse | undefined, now = Date.now()): AccountWord {
  const status = cached?.status
  if (data.relay.status === 'suspended' || status?.suspended) return 'suspended'
  if (data.relay.status === 'email-unconfirmed') return 'not confirmed'
  if (data.relay.status === 'account-required' || !data.account.attached) return 'no email'
  if (status?.handoverEndsAt && status.handoverEndsAt * 1000 > now) return 'handover'
  if (status?.state === 'confirmed') return 'confirmed'
  if (status?.state === 'pending') return 'pending'
  if (status?.state === 'blocked') return 'not confirmed'
  return 'added'
}

const ACCOUNT_LABEL: Record<AccountWord, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending confirmation',
  'not confirmed': 'Not confirmed',
  handover: 'Moving to a new email',
  suspended: 'Suspended',
  'no email': 'No email yet',
  added: 'Email added',
}

const host = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** A clock time today, a date otherwise. */
export function clock(iso: string, now = Date.now()): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / (24 * 60))} d ago`
}

export const percent = (share: number): string => `${Math.floor(share * 1000) / 10}%`

/** Statuses **Reconnect now** cannot change: up, off, stopped until restart, or suspended by the operator. */
const NO_RECONNECT: ReadonlySet<PhonesResponse['relay']['status']> = new Set(['connected', 'off', 'error', 'update-required', 'locked', 'suspended'])

function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-2 pb-1.5 text-meta">{children}</dl>
}

function Row({ label, children, slot }: { label: string; children: ReactNode; slot?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-slot={slot} className="min-w-0 text-right break-words text-foreground">{children}</dd>
    </>
  )
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <DropdownMenuLabel className="eyebrow px-2 pt-1.5 pb-1 text-meta font-semibold text-soft-foreground">{children}</DropdownMenuLabel>
}

/**
 * The phone entry's popover body: everything cezar already knows of its relay, its account and the
 * paired phones, from `GET /workspace/phones` and the account Settings last read. Asks the relay nothing.
 */
export function PhonesSummary({
  data,
  state,
  account,
  onNavigate,
  now = Date.now(),
}: {
  data: PhonesResponse
  state: PhoneIconState
  account: RelayAccountResponse | undefined
  onNavigate?: () => void
  now?: number
}) {
  const queryClient = useQueryClient()
  const reconnect = useMutation({
    mutationFn: reconnectRelay,
    onSuccess: (next) => queryClient.setQueryData(phoneKeys.list, next),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const keepAwake = useMutation({
    mutationFn: (enabled: boolean) => setRelayKeepAwake(enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: phoneKeys.list }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const { relay, phones } = data
  const email = data.account.email ?? account?.status?.email ?? undefined
  const word = accountWord(data, account, now)
  const awake = keepAwake.isPending && keepAwake.variables !== undefined ? keepAwake.variables : data.keepAwake.enabled
  const canReconnect = !NO_RECONNECT.has(relay.status)
  return (
    <>
      <div data-slot="phones-summary-header" className="flex items-center gap-2 px-2 pt-1.5 pb-1">
        <span className="text-ui font-medium text-foreground">Phones</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          {state.icon === 'ok' ? <StatusDot tone="success" aria-hidden="true" /> : null}
          {state.dot ? <StatusDot tone={state.dot} pulse={state.pulse} aria-hidden="true" /> : null}
          <span data-slot="phones-summary-status" className="truncate">{state.summary}</span>
        </span>
      </div>
      {state.icon === 'ok' ? null : (
        <p data-slot="phones-summary-detail" className="px-2 pb-1.5 text-meta text-muted-foreground">{state.text}</p>
      )}
      <DropdownMenuSeparator />

      <Eyebrow>Relay</Eyebrow>
      <Rows>
        <Row label="Host" slot="relay-host">{host(data.relayOrigin)}</Row>
        {relay.connectedAt ? <Row label="Connected since" slot="relay-since">{clock(relay.connectedAt, now)}</Row> : null}
        {relay.lastDown ? (
          <Row label="Last disconnect" slot="relay-last-down">
            {clock(relay.lastDown.at, now)} · {relay.lastDown.reason}{relay.lastDown.code !== undefined ? ` (${relay.lastDown.code})` : ''}
          </Row>
        ) : null}
        {relay.stats ? (
          <>
            <Row label="Relayed today" slot="relay-relayed">{relay.stats.relayedToday.toLocaleString()} {relay.stats.relayedToday === 1 ? 'message' : 'messages'}</Row>
            <Row label="Uptime" slot="relay-uptime">{percent(relay.stats.uptime)} since {clock(relay.stats.since, now)}</Row>
          </>
        ) : null}
      </Rows>
      {canReconnect ? (
        <DropdownMenuItem
          data-slot="relay-reconnect"
          className="text-ui"
          disabled={reconnect.isPending}
          onSelect={(event) => {
            event.preventDefault()
            reconnect.mutate()
          }}
        >
          <RefreshCwIcon aria-hidden="true" className={reconnect.isPending ? 'animate-spin motion-reduce:animate-none' : undefined} />
          Reconnect now
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />

      <Eyebrow>This computer</Eyebrow>
      <DropdownMenuItem asChild className="text-ui">
        <Link to={CONNECT_PHONE_HREF} data-slot="computer-name" onClick={onNavigate} title="Rename this computer in Settings › Connect a phone">
          <span className="min-w-0 flex-1 truncate">{data.account.computerName}</span>
          <PencilIcon aria-hidden="true" />
        </Link>
      </DropdownMenuItem>
      {data.keepAwake.unavailable === 'not-macos' ? null : (
        <DropdownMenuCheckboxItem
          data-slot="keep-awake"
          className="text-ui"
          checked={awake}
          disabled={data.keepAwake.unavailable !== undefined || keepAwake.isPending}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(next) => keepAwake.mutate(next)}
        >
          Keep awake for your phone
          <span className="ml-auto text-meta text-soft-foreground">{awake ? 'On' : 'Off'}</span>
        </DropdownMenuCheckboxItem>
      )}
      <DropdownMenuSeparator />

      <Eyebrow>Account</Eyebrow>
      <Rows>
        <Row label={email ? maskEmail(email) : 'Email'} slot="account-status">{ACCOUNT_LABEL[word]}</Row>
      </Rows>
      <DropdownMenuSeparator />

      <Eyebrow>{phones.length > 1 ? `Paired phones · ${phones.length}` : 'Paired phones'}</Eyebrow>
      {phones.length === 0 ? (
        <p className="px-2 pb-1.5 text-meta text-muted-foreground">None yet.</p>
      ) : (
        <ul data-slot="paired-phones" className="space-y-0.5 px-2 pb-1.5 text-meta">
          {phones.slice(0, PHONES_SHOWN).map((phone) => (
            <li key={phone.deviceId} data-slot="paired-phone" className="flex min-w-0 items-center gap-2">
              <StatusDot tone={phone.connected ? 'success' : 'neutral'} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground">{phone.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {phone.connected ? 'online' : phone.lastSeenAt ? `seen ${ago(phone.lastSeenAt, now)}` : 'never seen'}
                {' · '}
                {phone.push ? 'push on' : 'no push'}
              </span>
            </li>
          ))}
          {phones.length > PHONES_SHOWN ? (
            <li data-slot="paired-phones-more" className="text-muted-foreground">and {phones.length - PHONES_SHOWN} more</li>
          ) : null}
        </ul>
      )}
      <DropdownMenuSeparator />

      {phones.length === 0 ? (
        <DropdownMenuItem asChild className="text-ui">
          <Link to={CONNECT_PHONE_HREF} data-slot="phones-connect" onClick={onNavigate}>
            <PlusIcon aria-hidden="true" />
            Connect a phone
          </Link>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem asChild className="text-ui">
        <Link to={CONNECT_PHONE_HREF} data-slot="phones-settings" onClick={onNavigate}>
          <SettingsIcon aria-hidden="true" />
          Open phone settings
        </Link>
      </DropdownMenuItem>
    </>
  )
}

import type { Phone, PhonePairing, PhonePairingFailure, RelayStatus, StartPhonePairingResponse } from '@open-mercato/cezar-api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PencilIcon, SmartphoneIcon, Trash2Icon } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  approvePhonePairing, denyPhonePairing, phoneKeys, removePhone, renamePhone, revealPhoneCode, startPhonePairing, usePhones,
} from '@/api/phones'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'

const RELAY_STATUS: Record<RelayStatus, string> = {
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
}

const FAILURES: Record<PhonePairingFailure, string> = {
  'device-limit': 'This relay cannot take another phone. Remove one first.',
  'relay-error': 'The relay did not confirm the phone, so it was not added.',
  timeout: 'Nobody answered in time.',
  cancelled: 'The pairing was cancelled.',
  contested: 'A second phone tried to use this code, so it was cancelled. Show a new code and try again.',
  'bad-payload': 'The phone sent something cezar cannot read.',
  'tunnel-unsupported': 'This phone and this cezar need updating to work together.',
  'phone-left': 'The phone went away before pairing finished.',
}

const PENDING = new Set<PhonePairing['status']>(['waiting', 'handshaking', 'confirm', 'approving'])

/** The QR is drawn here, so the secret in it never leaves the browser for an image service. */
function QrCode({ value }: { value: string }) {
  const { path, size } = useMemo(() => {
    const code = qrcode(0, 'M')
    code.addData(value, 'Byte')
    code.make()
    const count = code.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) if (code.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`
    }
    return { path: d, size: count + 8 }
  }, [value])
  return (
    <svg role="img" aria-label="QR code to scan with the Cezar app" viewBox={`0 0 ${size} ${size}`} className="size-56 rounded-md bg-qr-ground" shapeRendering="crispEdges">
      <path d={path} className="fill-qr-module" />
    </svg>
  )
}

function useCountdown(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  return expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : 0
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function lastSeen(phone: Phone): string {
  if (phone.connected) return 'Connected'
  if (!phone.lastSeenAt) return 'Not connected yet'
  return `Seen ${new Date(phone.lastSeenAt).toLocaleString()}`
}

function ApprovalDialog({ pairing, onDecide, deciding }: { pairing: PhonePairing; onDecide: (approve: boolean) => void; deciding: boolean }) {
  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add this phone?</AlertDialogTitle>
          <AlertDialogDescription>
            Check that your phone shows the same number. This phone can run tasks on this computer, with everything a task can do.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-center font-mono text-5xl font-semibold tracking-widest tabular-nums" data-testid="phone-digits">
          {pairing.digits}
        </p>
        <p className="text-center text-sm text-muted-foreground">
          {pairing.phone?.name} ({pairing.phone?.platform}), as reported by the phone
        </p>
        <p className="text-sm text-muted-foreground">
          Approve only if you scanned or typed this inside the Cezar app, on your own phone.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deciding} onClick={() => onDecide(false)}>Deny</AlertDialogCancel>
          <AlertDialogAction disabled={deciding} onClick={() => onDecide(true)}>Approve</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PhoneRow({ phone, onRemove }: { phone: Phone; onRemove: () => void }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(phone.label)
  const rename = useMutation({
    mutationFn: () => renamePhone(phone.deviceId, label.trim()),
    onSuccess: async () => { setEditing(false); await queryClient.invalidateQueries({ queryKey: phoneKeys.list }) },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  return (
    <li className="flex items-center gap-3 py-2">
      <SmartphoneIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={(event) => { event.preventDefault(); if (label.trim()) rename.mutate() }}>
            <Input aria-label="Phone name" value={label} maxLength={64} autoFocus onChange={(event) => setLabel(event.target.value)} onBlur={() => setEditing(false)} />
          </form>
        ) : (
          <p className="truncate text-sm">{phone.label}</p>
        )}
        <p className="text-xs text-muted-foreground">{lastSeen(phone)}</p>
      </div>
      <Button variant="ghost" size="icon" aria-label={`Rename ${phone.label}`} onClick={() => { setLabel(phone.label); setEditing(true) }}>
        <PencilIcon className="size-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" aria-label={`Remove ${phone.label}`} onClick={onRemove}>
        <Trash2Icon className="size-4" aria-hidden />
      </Button>
    </li>
  )
}

/** Nothing here connects until the button: that click is the consent (QR2). */
export function PhonesSection() {
  const queryClient = useQueryClient()
  const list = usePhones()
  const [credentials, setCredentials] = useState<StartPhonePairingResponse | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Phone | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: phoneKeys.list })

  const pairing = list.data?.pairing ?? null
  const mine = credentials && pairing?.id === credentials.id ? pairing : null
  const seconds = useCountdown(credentials?.expiresAt)
  const showing = credentials !== null && (mine === null || mine.status === 'waiting') && seconds > 0

  const start = useMutation({
    mutationFn: startPhonePairing,
    onMutate: () => { setError(null); setCode(null) },
    onSuccess: async (started) => { setCredentials(started); await refresh() },
    onError: (failure: Error) => setError(failure.message),
  })
  const reveal = useMutation({
    mutationFn: (id: string) => revealPhoneCode(id),
    onSuccess: (revealed) => setCode(revealed.code),
    onError: (failure: Error) => setError(failure.message),
  })
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => (approve ? approvePhonePairing(id) : denyPhonePairing(id)),
    onSuccess: refresh,
    onError: (failure: Error) => toast(failure.message, { tone: 'danger' }),
  })
  const remove = useMutation({
    mutationFn: (deviceId: string) => removePhone(deviceId),
    onSuccess: async () => { setRemoving(null); await refresh() },
    onError: (failure: Error) => toast(failure.message, { tone: 'danger' }),
  })

  useEffect(() => {
    if (mine?.status !== 'approved') return
    toast(`${mine.phone?.name ?? 'Phone'} added`)
    setCredentials(null)
  }, [mine?.status, mine?.phone?.name])

  // A closed screen discards an undecided pairing, so a forgotten tab shows nothing usable.
  const openPairing = useRef<string | null>(null)
  openPairing.current = credentials && (!mine || PENDING.has(mine.status)) ? credentials.id : null
  useEffect(() => () => {
    if (openPairing.current) void denyPhonePairing(openPairing.current).catch(() => {})
  }, [])

  const failed = mine?.status === 'failed' ? FAILURES[mine.failure ?? 'phone-left'] : null
  const denied = mine?.status === 'denied' ? 'You denied that phone. Nothing was added.' : null
  const expired = credentials !== null && !showing && (mine === null || mine.status === 'expired' || mine.status === 'waiting')
  const relay = list.data?.relay
  const phones = list.data?.phones ?? []

  return (
    <div className="space-y-6">
      <section aria-labelledby="connect-phone" className="space-y-3">
        <h2 id="connect-phone" className="text-sm font-medium">Connect a phone</h2>
        {showing ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <QrCode value={credentials.qr} />
            <div className="space-y-2 text-sm">
              <p>Scan this inside the Cezar app, not with your camera app.</p>
              <p className="text-muted-foreground" aria-live="off">Expires in {clock(seconds)}</p>
              {code ? (
                <dl className="space-y-1">
                  <dt className="text-muted-foreground">Code</dt>
                  <dd className="font-mono text-lg tracking-wider">{code}</dd>
                  <dt className="text-muted-foreground">Relay address</dt>
                  <dd className="font-mono break-all">{credentials.relayOrigin}</dd>
                </dl>
              ) : (
                <Button variant="outline" size="sm" disabled={reveal.isPending} onClick={() => reveal.mutate(credentials.id)}>
                  Type a code instead
                </Button>
              )}
              {code ? <p className="text-xs text-muted-foreground">The QR code is safer: only it lets the app check it reached this computer.</p> : null}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Traffic crosses the relay encrypted. The relay can drop it, not read it. You confirm each phone here.
            </p>
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              {expired || failed || denied ? 'Show a new code' : 'Connect a phone'}
            </Button>
          </div>
        )}
        {mine?.status === 'handshaking' ? <p className="text-sm text-muted-foreground">Phone found. Checking it…</p> : null}
        {mine?.status === 'approving' ? <p className="text-sm text-muted-foreground">Adding the phone…</p> : null}
        {failed ?? denied ? <p role="status" className="text-sm text-muted-foreground">{failed ?? denied}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </section>

      <section aria-labelledby="your-phones" className="space-y-2">
        <h2 id="your-phones" className="text-sm font-medium">Your phones</h2>
        {list.isError ? <p role="alert" className="text-sm text-destructive">{list.error.message}</p> : null}
        {phones.length === 0 ? (
          <p className="text-sm text-muted-foreground">No phones yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {phones.map((phone) => <PhoneRow key={phone.deviceId} phone={phone} onRemove={() => setRemoving(phone)} />)}
          </ul>
        )}
        {list.data?.undeniedGrants ? (
          <p className="text-sm text-muted-foreground">
            The relay could not cancel every notification permission for a removed phone. It lapses within 90 days.
          </p>
        ) : null}
      </section>

      {relay ? (
        <p className="text-sm text-muted-foreground">
          Relay: {RELAY_STATUS[relay.status]}{relay.detail ? ` (${relay.detail})` : ''}
        </p>
      ) : null}

      {pairing?.status === 'confirm' ? (
        <ApprovalDialog pairing={pairing} deciding={decide.isPending} onDecide={(approve) => decide.mutate({ id: pairing.id, approve })} />
      ) : null}

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              It loses access to this computer at once. To use it again, pair it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (removing) remove.mutate(removing.deviceId) }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

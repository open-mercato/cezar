import { RELAY_TERMS, type RelayAccountResponse, type RelayAccountStatus } from '@open-mercato/cezar-api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'

import {
  confirmRelayAccount, deleteRelayAccount, phoneKeys, resendRelayAccountCode, setRelayAccount,
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

/** The relay account (RELAY_PROTOCOL.md § 18): an email and accepted terms before pairing. */

const EMAIL = /^[^@\s]+@[^@\s]+$/

/** "47 h 12 min", "12 min", "under a minute". */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

/** Seconds until `graceEndsAt`, ticking each 30 s so the screen never shows a stale figure for long. */
function useSecondsLeft(status: RelayAccountStatus | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())
  const ends = status?.graceEndsAt ?? null
  useEffect(() => {
    if (ends === null) return undefined
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [ends])
  return ends === null ? null : Math.max(0, ends - Math.floor(now / 1000))
}

export function AccountWhy() {
  return (
    <p className="text-sm text-muted-foreground">
      The relay is a service run by Open Mercato. Its terms and privacy obligations require knowing who accepted them and how to
      reach that person, so it asks for an email once per computer. The email is used only to confirm it is yours, for notices
      about the service, and to delete your data on request. Prompts, code and keys never reach the relay.
    </p>
  )
}

export function TermsLinks() {
  return (
    <>
      the{' '}
      <a href={RELAY_TERMS.termsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Terms</a>
      {' '}and{' '}
      <a href={RELAY_TERMS.privacyUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Privacy Policy</a>
    </>
  )
}

/** Email and the terms checkbox. Submitting needs both; the server refuses anything else anyway. */
export function AccountForm({ initialEmail = '', submitLabel, onDone, onCancel }: {
  initialEmail?: string
  submitLabel: string
  onDone?: (answer: RelayAccountResponse) => void
  onCancel?: () => void
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const [email, setEmail] = useState(initialEmail)
  const [accepted, setAccepted] = useState(false)
  const save = useMutation({
    mutationFn: () => setRelayAccount(email.trim(), RELAY_TERMS.version),
    onSuccess: async (answer) => {
      queryClient.setQueryData(phoneKeys.account, answer)
      await queryClient.invalidateQueries({ queryKey: phoneKeys.list })
      if (answer.problem === 'unsupported') toast('This relay has no accounts, so none is needed.')
      else if (answer.status?.state === 'confirmed') toast('Email confirmed.')
      else if (answer.codeSent) toast(`We sent a code to ${email.trim()}.`)
      else if (answer.retryAfter) toast(`Account saved. A new code can be sent in ${timeLeft(answer.retryAfter)}.`)
      else if (answer.codeSent === false) toast('Account saved, but the email could not be sent. Use Resend code.', { tone: 'danger' })
      onDone?.(answer)
    },
  })
  const valid = EMAIL.test(email.trim()) && accepted
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate() }}
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-email`} className="text-sm font-medium">Email</label>
        <Input
          id={`${id}-email`}
          type="email"
          autoComplete="email"
          value={email}
          maxLength={254}
          placeholder="you@example.com"
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>I accept <TermsLinks /></span>
      </label>
      {save.isError ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || save.isPending}>{submitLabel}</Button>
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  )
}

function CodeEntry() {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const confirm = useMutation({
    mutationFn: () => confirmRelayAccount(code.trim()),
    onSuccess: async (answer) => {
      queryClient.setQueryData(phoneKeys.account, answer)
      setCode('')
      toast(answer.status?.state === 'confirmed' ? 'Email confirmed. Your phones reconnect on their own.' : 'Code accepted.')
      await queryClient.invalidateQueries({ queryKey: phoneKeys.list })
    },
  })
  const resend = useMutation({
    mutationFn: resendRelayAccountCode,
    onSuccess: () => toast('A new code is on its way.'),
    onError: (failure: Error) => toast(failure.message, { tone: 'danger' }),
  })
  return (
    <div className="space-y-2">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (/^\d{6}$/.test(code.trim())) confirm.mutate() }}>
        <div className="space-y-1">
          <label htmlFor="relay-account-code" className="text-sm">Code from the email</label>
          <Input
            id="relay-account-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="w-32 font-mono tracking-widest"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        </div>
        <Button type="submit" size="sm" disabled={!/^\d{6}$/.test(code) || confirm.isPending}>Confirm</Button>
        <Button type="button" size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate()}>Resend code</Button>
      </form>
      {confirm.isError ? <p role="alert" className="text-sm text-destructive">{confirm.error.message}</p> : null}
      <p className="text-xs text-muted-foreground">Or follow the link in the email. Either way, no phone has to pair again.</p>
    </div>
  )
}

function StatusLine({ status, email, secondsLeft }: { status: RelayAccountStatus; email: string | undefined; secondsLeft: number | null }) {
  const who = status.email ?? email ?? 'your email'
  if (status.state === 'confirmed') return <p className="text-sm" data-testid="relay-account-state">Account: <strong>{who}</strong>, confirmed.</p>
  if (status.state === 'blocked') {
    return (
      <p role="alert" className="text-sm text-destructive" data-testid="relay-account-state">
        Account: <strong>{who}</strong> was not confirmed within 48 hours, so the relay stopped connecting your phones. Confirm it to
        reconnect them. No phone has to pair again.
      </p>
    )
  }
  return (
    <p className="text-sm" data-testid="relay-account-state">
      Account: <strong>{who}</strong>, waiting for confirmation.
      {secondsLeft !== null ? ` Phones keep working for ${timeLeft(secondsLeft)}; confirm before then.` : ''}
    </p>
  )
}

/**
 * Settings > Connect a phone, above the code. `account` is the relay's answer, read when Settings
 * opens; `null` while it loads. Pairing is gated by the caller on `local.attached`.
 */
export function RelayAccountPanel({ account, loading }: { account: RelayAccountResponse | undefined; loading: boolean }) {
  const queryClient = useQueryClient()
  const [changing, setChanging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const secondsLeft = useSecondsLeft(account?.status)
  const remove = useMutation({
    mutationFn: deleteRelayAccount,
    onSuccess: () => { setDeleting(false); toast('Check your email for the link that finishes the deletion.') },
    onError: (failure: Error) => { setDeleting(false); toast(failure.message, { tone: 'danger' }) },
  })
  if (loading && !account) return <p className="text-sm text-muted-foreground">Checking your relay account…</p>
  if (!account) return null
  if (account.problem === 'unsupported') return null
  const { local, status } = account
  const attached = local.attached && status?.email !== null

  if (!attached || changing) {
    return (
      <div className="space-y-3 rounded-md border border-border p-3" data-testid="relay-account-form">
        <p className="text-sm font-medium">{changing ? 'Change email' : 'Before the first phone: your email'}</p>
        <AccountWhy />
        {!changing && status && status.secondsLeft !== null && (local.prompt || status.state !== 'confirmed') ? (
          <p className="text-sm">Phones already paired keep working for {timeLeft(secondsLeft ?? status.secondsLeft)}.</p>
        ) : null}
        <AccountForm
          initialEmail={local.email ?? ''}
          submitLabel={changing ? 'Change email' : 'Continue'}
          onDone={() => setChanging(false)}
          {...(changing ? { onCancel: () => setChanging(false) } : {})}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="relay-account">
      {status ? (
        <StatusLine status={status} email={local.email} secondsLeft={secondsLeft} />
      ) : (
        <p className="text-sm">
          Account: <strong>{local.email}</strong>.{' '}
          <span className="text-muted-foreground">
            {account.problem === 'no-keys' ? 'Unlock the keychain to check its status.' : 'Could not reach the relay to check its status.'}
          </span>
        </p>
      )}
      {status && status.state !== 'confirmed' ? <CodeEntry /> : null}
      {status && status.state !== 'confirmed' ? <AccountWhy /> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setChanging(true)}>Change email</Button>
        <Button size="sm" variant="ghost" onClick={() => void queryClient.invalidateQueries({ queryKey: phoneKeys.account })}>Check again</Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(true)}>Delete account</Button>
      </div>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your relay account?</AlertDialogTitle>
            <AlertDialogDescription>
              The relay emails a link to {status?.email ?? local.email}. Following it deletes the account and the list of your phones. Paired
              phones keep working only until the 48-hour grace this computer started with ends, so you will be asked for an email again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate()}>Send the link</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

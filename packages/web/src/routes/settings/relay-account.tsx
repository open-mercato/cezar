import { RELAY_TERMS, type RelayAccountResponse, type RelayAccountStatus } from '@open-mercato/cezar-api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'

import { checkRelayAccount, deleteRelayAccount, phoneKeys, resendRelayAccountLink, setRelayAccount } from '@/api/phones'
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

/**
 * The relay account (RELAY_PROTOCOL.md § 18): an email and accepted terms, asked in the pairing flow.
 * Confirming is the emailed link's button at the relay; nothing here takes a code.
 */

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
      else if (answer.codeSent) toast(`We sent a link to ${email.trim()}. Open it to confirm.`)
      else if (answer.retryAfter) toast(`Account saved. A new link can be sent in ${timeLeft(answer.retryAfter)}.`)
      else if (answer.codeSent === false) toast('Account saved, but the email could not be sent. Use Send a new link.', { tone: 'danger' })
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

/** Waiting for the emailed link: Check now asks the relay, Send a new link mails another. */
export function LinkWaiting({ email }: { email: string }) {
  const queryClient = useQueryClient()
  const check = useMutation({
    mutationFn: checkRelayAccount,
    onSuccess: async (answer) => {
      queryClient.setQueryData(phoneKeys.account, answer)
      if (answer.status?.state === 'confirmed') {
        toast('Email confirmed. Your phones reconnect on their own.')
        await queryClient.invalidateQueries({ queryKey: phoneKeys.list })
      } else {
        toast('Not confirmed yet. Open the link in the email.')
      }
    },
    onError: (failure: Error) => toast(failure.message, { tone: 'danger' }),
  })
  const resend = useMutation({
    mutationFn: resendRelayAccountLink,
    onSuccess: () => toast(`A new link is on its way to ${email}.`),
    onError: (failure: Error) => toast(failure.message, { tone: 'danger' }),
  })
  return (
    <div className="space-y-2" data-testid="relay-account-link">
      <p className="text-sm">We sent a link to <strong>{email}</strong>. Open it to confirm.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={check.isPending} onClick={() => check.mutate()}>Check now</Button>
        <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate()}>Send a new link</Button>
      </div>
      <p className="text-xs text-muted-foreground">This screen checks on its own once a minute. No phone has to pair again.</p>
    </div>
  )
}

function StatusLine({ status, email, secondsLeft }: { status: RelayAccountStatus; email: string | undefined; secondsLeft: number | null }) {
  const who = status.email ?? email ?? 'your email'
  if (status.state === 'confirmed') return <p className="text-sm" data-testid="relay-account-state">Account: <strong>{who}</strong>, confirmed.</p>
  if (status.state === 'blocked') {
    return (
      <p role="alert" className="text-sm text-destructive" data-testid="relay-account-state">
        Account: <strong>{who}</strong> was not confirmed within 48 hours, so the relay stopped connecting your phones. Open the
        link in the email to reconnect them.
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

/** The pairing flow's first step: shown before the QR when no account is held, and from the notice. */
export function AccountStep({ account, onDone, onCancel }: {
  account: RelayAccountResponse | undefined
  onDone: (answer: RelayAccountResponse) => void
  onCancel: () => void
}) {
  const secondsLeft = useSecondsLeft(account?.status)
  const status = account?.status
  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="relay-account-form">
      <p className="text-sm font-medium">Before the code: your email</p>
      <AccountWhy />
      {status && status.secondsLeft !== null && status.state !== 'confirmed' ? (
        <p className="text-sm">Phones already paired keep working for {timeLeft(secondsLeft ?? status.secondsLeft)}.</p>
      ) : null}
      <AccountForm initialEmail={account?.local.email ?? ''} submitLabel="Continue" onDone={onDone} onCancel={onCancel} />
    </div>
  )
}

/** Phones paired before accounts, with none held: a notice, never a modal, opening the same step. */
export function MissingAccountNotice({ account, onAdd }: { account: RelayAccountResponse | undefined; onAdd: () => void }) {
  const secondsLeft = useSecondsLeft(account?.status)
  const left = secondsLeft ?? account?.status?.secondsLeft ?? null
  return (
    <div role="status" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" data-testid="relay-account-missing">
      <p className="text-sm">
        Your paired phones need an email on file{left !== null ? `. They keep working for ${timeLeft(left)}` : ''}.
      </p>
      <Button size="sm" onClick={onAdd}>Add email</Button>
    </div>
  )
}

/**
 * Settings > Connect a phone: the attached account's status. `account` is the relay's answer, read
 * when Settings opens; nothing renders until an account is held.
 */
export function RelayAccountPanel({ account, loading }: { account: RelayAccountResponse | undefined; loading: boolean }) {
  const [changing, setChanging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const secondsLeft = useSecondsLeft(account?.status)
  const remove = useMutation({
    mutationFn: deleteRelayAccount,
    onSuccess: () => { setDeleting(false); toast('Check your email for the link that finishes the deletion.') },
    onError: (failure: Error) => { setDeleting(false); toast(failure.message, { tone: 'danger' }) },
  })
  if (loading && !account) return <p className="text-sm text-muted-foreground">Checking your relay account…</p>
  if (!account || account.problem === 'unsupported') return null
  const { local, status } = account
  if (!local.attached || status?.email === null) return null

  if (changing) {
    return (
      <div className="space-y-3 rounded-md border border-border p-3" data-testid="relay-account-form">
        <p className="text-sm font-medium">Change email</p>
        <AccountForm initialEmail={local.email ?? ''} submitLabel="Change email" onDone={() => setChanging(false)} onCancel={() => setChanging(false)} />
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
      {status && status.state !== 'confirmed' ? <LinkWaiting email={status.email ?? local.email ?? 'your email'} /> : null}
      {status && status.state !== 'confirmed' ? <AccountWhy /> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setChanging(true)}>Change email</Button>
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

import { CheckIcon } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { agentAccountRouteId, type AgentProfile, type ProviderId } from '@open-mercato/cezar-api-client'

import { ApiError, getAgentAccountDetails } from '@/api/client'
import {
  useAgentAccountDetails,
  useAgentProfiles,
  useCreateAgentProfile,
  useRemoveAgentProfile,
  useSelectAgentProfile,
  workspaceQueryKeys,
} from '@/api/queries'
import { agentName, failureCopy, TERMINAL_ONLY } from '@/components/reconnect/copy'
import { SigningActions, SigningBody } from '@/components/reconnect/reconnect-card'
import { RunnerMark } from '@/components/reconnect/runner-mark'
import { NARROW_QUERY, useReconnect } from '@/components/reconnect/use-reconnect'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { AccountPlanUsage } from '@/routes/settings/account-plan-usage'

/**
 * Add an agent account from the cockpit (spec 2026-11-24-add-account-in-cockpit): pick an agent
 * and a name, cezar makes a private folder and runs the agent's own sign-in in it, then shows who
 * signed in. The sign-in body is the reconnect card's, so the two flows cannot drift apart.
 * Cancelling after the folder exists removes the account and its folder.
 */
export interface AddAccountWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Agents that can carry more than one account (the server's `profileCapableProviders`). */
  providers: readonly ProviderId[]
  initialProvider?: ProviderId | undefined
  /** The folder-path dialog, offered as Advanced; absent where host paths are not shown. */
  onAdvanced?: (() => void) | undefined
  /** Finish the sign-in of an account added earlier that is still pending. */
  resume?: AgentProfile | undefined
  /** Called once the new account is signed in. */
  onAdded?: ((profile: AgentProfile) => void) | undefined
}

type Step = 'pick' | 'signing' | 'ready'

export function AddAccountWizard({ open, onOpenChange, providers, initialProvider, onAdvanced, resume, onAdded }: AddAccountWizardProps) {
  const narrow = useMediaQuery(NARROW_QUERY)
  const [provider, setProvider] = useState<ProviderId>(resume?.provider ?? (initialProvider && providers.includes(initialProvider) ? initialProvider : providers[0] ?? 'claude'))
  const [label, setLabel] = useState('')
  const [account, setAccount] = useState<AgentProfile | null>(resume ?? null)
  const [step, setStep] = useState<Step>(resume ? 'signing' : 'pick')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const create = useCreateAgentProfile()
  const remove = useRemoveAgentProfile()

  const close = () => onOpenChange(false)
  /** Signing in: closing asks first, because it deletes what was made. */
  const requestClose = () => {
    if (step === 'signing' && account) setConfirmCancel(true)
    else close()
  }
  const discard = () => {
    if (!account) return close()
    remove.mutate(account.id, {
      onSettled: () => {
        setConfirmCancel(false)
        close()
      },
      onError: (error) => toast(error.message, { tone: 'danger' }),
    })
  }

  const begin = () => {
    if (create.isPending) return
    create.mutate(
      { provider, managed: true, ...(label.trim() ? { label: label.trim() } : {}) },
      {
        onSuccess: ({ profile }) => {
          setAccount(profile)
          setStep('signing')
        },
      },
    )
  }

  const stepIndex = step === 'pick' ? 0 : step === 'signing' ? 1 : 2
  const header = (
    <>
      <span className="flex items-center gap-2">
        <RunnerMark provider={account?.provider ?? provider} />
        Add agent account
      </span>
    </>
  )
  let body: ReactNode
  if (step === 'pick') {
    body = (
      <PickStep
        providers={providers}
        provider={provider}
        onProvider={(next) => { setProvider(next); create.reset() }}
        label={label}
        onLabel={(next) => { setLabel(next); create.reset() }}
        error={create.error ? createError(create.error) : null}
        pending={create.isPending}
        narrow={narrow}
        onCancel={close}
        onContinue={begin}
        onAdvanced={onAdvanced}
      />
    )
  } else if (account && step === 'signing') {
    body = confirmCancel ? (
      <ConfirmCancel account={account} busy={remove.isPending} onKeep={() => setConfirmCancel(false)} onDiscard={discard} narrow={narrow} />
    ) : (
      <SignInStep
        account={account}
        narrow={narrow}
        onSignedIn={() => setStep('ready')}
        onCancel={() => setConfirmCancel(true)}
      />
    )
  } else if (account) {
    body = (
      <ReadyStep
        account={account}
        narrow={narrow}
        onDone={(kept) => {
          if (kept) onAdded?.(account)
          close()
        }}
        onRemove={discard}
        removing={remove.isPending}
      />
    )
  }

  const content = (
    <>
      <Stepper index={stepIndex} />
      {body}
    </>
  )

  if (narrow) {
    return (
      <Sheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <SheetContent side="bottom" data-slot="add-account-wizard" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div aria-hidden="true" className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" />
          <SheetTitle className="text-base">{header}</SheetTitle>
          <SheetDescription className="sr-only">Sign in to a new agent account.</SheetDescription>
          {content}
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent data-slot="add-account-wizard" className="sm:max-w-lg">
        <DialogTitle>{header}</DialogTitle>
        <DialogDescription className="sr-only">Sign in to a new agent account.</DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  )
}

function createError(error: Error): string {
  return error instanceof ApiError ? error.message : error.message || 'Could not add the account.'
}

function Stepper({ index }: { index: number }) {
  return (
    <ol data-slot="add-account-steps" className="flex gap-1.5 text-micro text-soft-foreground">
      {['Agent', 'Sign in', 'Ready'].map((title, i) => (
        <li
          key={title}
          data-state={i < index ? 'done' : i === index ? 'now' : 'todo'}
          className={cn(
            'flex flex-1 items-center gap-1 border-t-2 border-muted pt-1.5',
            i < index && 'border-success text-success-strong',
            i === index && 'border-foreground text-foreground',
          )}
        >
          {i < index ? <CheckIcon aria-hidden="true" className="size-3" /> : <span aria-hidden="true">{i + 1}</span>}
          {title}
        </li>
      ))}
    </ol>
  )
}

function Footer({ narrow, children }: { narrow: boolean; children: ReactNode }) {
  return <div className={cn('mt-2 flex gap-2', narrow ? 'flex-col-reverse items-stretch' : 'items-center justify-end')}>{children}</div>
}

function PickStep({ providers, provider, onProvider, label, onLabel, error, pending, narrow, onCancel, onContinue, onAdvanced }: {
  providers: readonly ProviderId[]
  provider: ProviderId
  onProvider: (provider: ProviderId) => void
  label: string
  onLabel: (label: string) => void
  error: string | null
  pending: boolean
  narrow: boolean
  onCancel: () => void
  onContinue: () => void
  onAdvanced: (() => void) | undefined
}) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        onContinue()
      }}
    >
      <div role="radiogroup" aria-label="Agent" className={cn('grid gap-2', narrow ? 'grid-cols-1' : 'grid-cols-2')}>
        {providers.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === provider}
            data-provider={id}
            onClick={() => onProvider(id)}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-left text-ui',
              id === provider && 'border-ring ring-[3px] ring-ring/25',
            )}
          >
            <RunnerMark provider={id} />
            <span className="min-w-0">
              <span className="block font-medium">{agentName(id)}</span>
              <span className="block text-micro text-soft-foreground">{TERMINAL_ONLY.has(id) ? 'Signs in in a terminal' : 'Signs in through its web page'}</span>
            </span>
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Account name
        <Input
          type="text"
          data-slot="add-account-name"
          value={label}
          placeholder="Work"
          maxLength={200}
          onChange={(event) => onLabel(event.target.value)}
          className="h-9 text-base md:text-sm"
        />
      </label>
      {error ? <p data-slot="add-account-error" role="alert" className="text-ui text-danger">{error}</p> : null}
      {onAdvanced ? (
        <button type="button" data-action="add-account-advanced" onClick={onAdvanced} className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:no-underline">
          Advanced: use a folder that is already signed in
        </button>
      ) : null}
      <Footer narrow={narrow}>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="contrast" data-action="add-account-continue" disabled={pending}>
          {pending ? <Spinner className="size-3" /> : null}
          Continue · sign in
        </Button>
      </Footer>
    </form>
  )
}

/** Step 2: the reconnect card's sign-in, started once for the new account. */
function SignInStep({ account, narrow, onSignedIn, onCancel }: {
  account: AgentProfile
  narrow: boolean
  onSignedIn: () => void
  onCancel: () => void
}) {
  const { session, view, startError, remote, who, start, recheck, reconnect, checkAgain, stop } = useReconnect(account.provider, account.id)
  const queryClient = useQueryClient()
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    reconnect()
  }, [])
  useEffect(() => {
    if (view !== 'success') return
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles })
    onSignedIn()
  }, [view])

  const cancel = () => {
    stop()
    onCancel()
  }

  if (view === 'failed') {
    const reason = startError?.message ?? failureCopy(session?.reason, session?.method, account.provider, account.label)
    return (
      <div className="flex flex-col gap-3">
        <div data-slot="add-account-failed" role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-ui">
          <b className="font-semibold">Sign-in to {who} didn't finish.</b> <span className="text-muted-foreground">{reason}</span>
        </div>
        <Footer narrow={narrow}>
          <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
          <Button type="button" variant="contrast" data-action="add-account-retry" disabled={start.isPending} onClick={() => reconnect()}>
            {session?.reason === 'expired' ? 'Get a new code' : 'Try again'}
          </Button>
        </Footer>
      </div>
    )
  }
  return (
    <div data-slot="add-account-signing" className="flex flex-col gap-3">
      {session ? (
        <SigningBody session={session} who={who} remote={remote} compact={narrow} stepsLabel="verify" />
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Creating a private folder and starting {agentName(account.provider)}'s sign-in…
        </p>
      )}
      <Footer narrow={narrow}>
        {session ? (
          <SigningActions
            session={session}
            remote={remote}
            stacked={narrow}
            checking={recheck.isPending}
            onCheck={checkAgain}
            onRestart={() => reconnect()}
            onCancel={cancel}
          />
        ) : (
          <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
        )}
      </Footer>
    </div>
  )
}

function ConfirmCancel({ account, busy, narrow, onKeep, onDiscard }: {
  account: AgentProfile
  busy: boolean
  narrow: boolean
  onKeep: () => void
  onDiscard: () => void
}) {
  return (
    <div data-slot="add-account-cancel" className="flex flex-col gap-3">
      <p className="text-ui">
        <b className="font-semibold">Stop adding {agentName(account.provider)} · {account.label}?</b>
        <br />
        <span className="text-muted-foreground">
          The sign-in stops and the folder cezar made for it is deleted. Your other {agentName(account.provider)} logins are not touched.
        </span>
      </p>
      <Footer narrow={narrow}>
        <Button type="button" variant="ghost" onClick={onKeep}>Keep signing in</Button>
        <Button type="button" variant="destructive" data-action="add-account-discard" disabled={busy} onClick={onDiscard}>Stop &amp; delete</Button>
      </Footer>
    </div>
  )
}

const emailOf = (fields: ReadonlyArray<{ label: string; value: string }> | undefined): string | undefined =>
  fields?.find((field) => field.label === 'Email')?.value.trim().toLowerCase() || undefined

/** Step 3: who signed in, its plan, and the one optional default. */
function ReadyStep({ account, narrow, removing, onDone, onRemove }: {
  account: AgentProfile
  narrow: boolean
  removing: boolean
  onDone: (kept: boolean) => void
  onRemove: () => void
}) {
  const profiles = useAgentProfiles().data
  const details = useAgentAccountDetails(agentAccountRouteId(account), true)
  const select = useSelectAgentProfile()
  const [makeDefault, setMakeDefault] = useState(false)
  const hostPaths = profiles?.hostPaths !== false
  const others = (profiles?.profiles ?? []).filter((row) => row.provider === account.provider && row.id !== account.id && !row.pending)
  const otherDetails = useQueries({
    queries: others.map((row) => ({
      queryKey: workspaceQueryKeys.agentAccountDetails(agentAccountRouteId(row)),
      queryFn: ({ signal }: { signal: AbortSignal }) => getAgentAccountDetails(agentAccountRouteId(row), { signal }),
      staleTime: 0,
      retry: false,
    })),
  })
  const mine = details.data?.available ? emailOf(details.data.fields) : undefined
  const twinIndex = mine === undefined ? -1 : otherDetails.findIndex((query) => query.data?.available && emailOf(query.data.fields) === mine)
  const twin = twinIndex >= 0 ? others[twinIndex] : undefined
  const name = `${agentName(account.provider)} · ${account.label}`

  const done = () => {
    if (!makeDefault) return onDone(true)
    select.mutate(
      { projectId: null, provider: account.provider, profileId: account.id },
      {
        onSuccess: () => onDone(true),
        onError: (error) => toast(error.message, { tone: 'danger' }),
      },
    )
  }

  return (
    <div data-slot="add-account-ready" className="flex flex-col gap-3">
      <div role="status" className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-ui">
        <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-success-strong" />
        <span><b className="font-semibold">{name}</b> is signed in and ready.</span>
      </div>
      {twin ? (
        <div data-slot="add-account-duplicate" className="rounded-lg border border-pending/35 bg-pending/5 px-3 py-2 text-ui">
          <b className="font-semibold">This is the same login as “{twin.label}”</b>{' '}
          <span className="text-muted-foreground">({mine}). Two accounts on one login share one subscription and its limits.</span>
        </div>
      ) : null}
      {details.isPending ? (
        <p className="text-label text-muted-foreground">Reading account details…</p>
      ) : details.data?.available ? (
        <dl data-slot="add-account-identity" className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
          {details.data.fields.map((field) => (
            <Fragment key={field.label}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-all">{field.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : details.data?.reason ? (
        <p className="text-label text-muted-foreground">{details.data.reason}</p>
      ) : null}
      {account.provider === 'claude' || account.provider === 'codex' ? (
        <AccountPlanUsage provider={account.provider} accountId={account.id} />
      ) : null}
      {hostPaths ? (
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" data-slot="add-account-default" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
          Use it for projects that have not picked a {agentName(account.provider)} account
        </label>
      ) : null}
      <Footer narrow={narrow}>
        {twin ? (
          <Button type="button" variant="ghost" data-action="add-account-remove-duplicate" disabled={removing} onClick={onRemove}>
            Remove this one
          </Button>
        ) : null}
        <Button type="button" variant="contrast" data-action="add-account-done" disabled={select.isPending} onClick={done}>
          {twin ? 'Keep both' : 'Done'}
        </Button>
      </Footer>
    </div>
  )
}

import type { ProviderId } from '@open-mercato/cezar-api-client'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

import { agentName } from './copy'
import { ReconnectCard } from './reconnect-card'
import { RunnerMark } from './runner-mark'
import { useReconnect } from './use-reconnect'

/** Reconnect as a single button (banner, attention row). Signing in continues in the card. */
export function ReconnectButton({ provider, profileId, label = 'Reconnect', variant = 'contrast' }: {
  provider: ProviderId
  profileId: string
  label?: string
  variant?: 'contrast' | 'outline'
}) {
  const { view, start, reconnect } = useReconnect(provider, profileId)
  if (view === 'signing') {
    return (
      <span data-slot="reconnect-signing" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Signing in…
      </span>
    )
  }
  return (
    <Button type="button" variant={variant} size="sm" data-action="reconnect-start" disabled={start.isPending} className="shrink-0" onClick={() => reconnect()}>
      {label}
    </Button>
  )
}

/** The card a button started, once there is something to show beyond "signed out". */
export function ReconnectProgress({ provider, profileId, className }: { provider: ProviderId; profileId: string; className?: string }) {
  const { view } = useReconnect(provider, profileId)
  if (view === 'expired') return null
  return <ReconnectCard provider={provider} profileId={profileId} place="attention" className={className} />
}

/**
 * One "Sign-in needed" row: an account and everything blocked on it, with one Reconnect
 * (design, Attention & banner). Grouped per account, never per task.
 */
export function SignInRow({ provider, profileId, blocks, first = false }: {
  provider: ProviderId
  profileId: string
  /** What waits on the account: "“Fix flaky test”", "manager “Triage”". */
  blocks: readonly string[]
  /** The top row's Reconnect is the primary action. */
  first?: boolean
}) {
  const { account, view } = useReconnect(provider, profileId)
  return (
    <li data-slot="sign-in-row" data-account={`${provider}:${profileId}`} className="border-t border-border first:border-t-0">
      <div className={cn('flex items-center gap-3 px-3.5 py-2.5 text-sm', first && 'bg-card-2')}>
        <RunnerMark provider={provider} />
        <div className="min-w-0 flex-1">
          <p><b className="font-semibold">{agentName(provider)} · {account}</b> signed out</p>
          {blocks.length > 0 ? (
            <p className="truncate text-micro text-soft-foreground">Blocks {blocks.join(', ')}</p>
          ) : null}
        </div>
        {view === 'success' ? null : <ReconnectButton provider={provider} profileId={profileId} variant={first ? 'contrast' : 'outline'} />}
      </div>
      <ReconnectProgress provider={provider} profileId={profileId} className="mx-3.5 mt-0 mb-3" />
    </li>
  )
}

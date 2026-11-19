import { useQuery, type QueryClient } from '@tanstack/react-query'
import {
  accountReconnectedEventSchema,
  loginSessionSchema,
  type AccountReconnectedEvent,
  type LoginSession,
  type ProviderId,
  type ReconnectResumed,
} from '@open-mercato/cezar-api-client'

import { toast } from '@/components/ui/toaster'
import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

import { refreshManagerChats } from './managers'
import { clearLoginSession, isActiveLoginSession, queryKeys, workspaceQueryKeys, writeLoginSession } from './queries'


/**
 * Inline account reconnect's client state (spec 2026-11-18-inline-account-reconnect).
 *
 * One login session per ACCOUNT, not per card: every card for `claude · Work` reads the same
 * cache entry, so the transcript, the chat and the banner all show the same signing state.
 */

/** What every surface remembers about an account that came back. */
export interface AccountReconnectedNews {
  at: string
  resumed: ReconnectResumed
}

const NEVER = () => Promise.resolve(null)

/** The account's newest login session; undefined until one is started or streamed in. */
export function useLoginSession(provider: ProviderId, profileId: string): LoginSession | undefined {
  return useQuery<LoginSession | null>({
    queryKey: workspaceQueryKeys.agentLogin(provider, profileId),
    queryFn: NEVER,
    enabled: false,
    staleTime: Infinity,
  }).data ?? undefined
}

export function useAccountReconnected(provider: ProviderId, profileId: string): AccountReconnectedNews | undefined {
  return useQuery<AccountReconnectedNews | null>({
    queryKey: workspaceQueryKeys.accountReconnected(provider, profileId),
    queryFn: NEVER,
    enabled: false,
    staleTime: Infinity,
  }).data ?? undefined
}

export { clearLoginSession, isActiveLoginSession as isActive, writeLoginSession }

/** Workspace SSE `agent-login`: every phase change of a session, from any tab or phone. */
export function applyAgentLoginEvent(queryClient: QueryClient, payload: unknown): void {
  const parsed = loginSessionSchema.safeParse(payload)
  if (!parsed.success) return
  writeLoginSession(queryClient, parsed.data)
}

/**
 * Workspace SSE `account-reconnected`: the account is back (any path), and the server restarted
 * what was blocked on it. Everything that drew the card refetches; the toast says what resumed.
 */
export function applyAccountReconnectedEvent(queryClient: QueryClient, payload: unknown, label?: string): void {
  const parsed = accountReconnectedEventSchema.safeParse(payload)
  if (!parsed.success) return
  const event = parsed.data
  queryClient.setQueryData<AccountReconnectedNews>(
    workspaceQueryKeys.accountReconnected(event.provider, event.profileId),
    { at: new Date().toISOString(), resumed: event.resumed },
  )
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles })
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
  void refreshManagerChats(queryClient)
  toast(reconnectedToast(event, label ?? accountLabel(queryClient, event.provider, event.profileId)), {
    ...(resumedCount(event.resumed) > 0 ? { action: { label: 'Review', href: reviewHref(event.resumed) } } : {}),
  })
}

export function resumedCount(resumed: ReconnectResumed): number {
  return resumed.runs.length + resumed.managers.length
}

export function reconnectedToast(event: Pick<AccountReconnectedEvent, 'provider' | 'resumed'>, account: string): string {
  const count = resumedCount(event.resumed)
  const who = `${PROVIDER_LABELS[event.provider]} · ${account}`
  return count === 0 ? `${who} is back` : `${who} is back — resumed ${count}`
}

/** The one resumed item when there is one; the global task list otherwise. */
function reviewHref(resumed: ReconnectResumed): string {
  if (resumed.runs.length === 1 && resumed.managers.length === 0) {
    const run = resumed.runs[0]!
    return `/p/${encodeURIComponent(run.projectId)}/tasks/${encodeURIComponent(run.runId)}`
  }
  if (resumed.managers.length === 1 && resumed.runs.length === 0) return `/manager/${encodeURIComponent(resumed.managers[0]!.managerId)}`
  return '/tasks'
}

/** The account's display name from the cached listing: `Default` for the discovered login. */
export function accountLabel(queryClient: QueryClient, provider: ProviderId, profileId: string): string {
  const listing = queryClient.getQueryData<{ profiles: { id: string; provider: string; label: string }[] }>(workspaceQueryKeys.agentProfiles)
  return listing?.profiles.find((row) => row.provider === provider && row.id === profileId)?.label
    ?? (profileId === 'default' ? 'Default' : profileId)
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LoginMethod, ProviderId } from '@open-mercato/cezar-api-client'

import { useAccountReconnected, useLoginSession } from '@/api/agent-login'
import { ApiError } from '@/api/client'
import {
  clearLoginSession,
  isActiveLoginSession,
  useAgentProfiles,
  useCancelLoginSession,
  useHealth,
  useRecheckAgentAccount,
  useStartLoginSession,
  workspaceQueryKeys,
} from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import { isPhone } from '@/lib/phone-app'
import { useMediaQuery } from '@/lib/use-media-query'

import { agentName } from './copy'

export type ReconnectView = 'expired' | 'signing' | 'success' | 'failed'

/** A refused start (hosted cockpit, not installed): the server's words and its terminal command. */
export interface ReconnectStartError {
  message: string
  command?: string
}

export const NARROW_QUERY = '(max-width: 767px)'

const startErrorKey = (provider: ProviderId, profileId: string) => [...workspaceQueryKeys.agentLogin(provider, profileId), 'start-error'] as const
const NEVER = () => Promise.resolve(null)

/**
 * One account's reconnect, for every surface that offers it (card, attention row, banner). The
 * state is the account's — session and refused start both live in the query cache — so a row's
 * Reconnect and the card it opens are one sign-in, not two.
 */
export function useReconnect(provider: ProviderId, profileId: string) {
  const queryClient = useQueryClient()
  const session = useLoginSession(provider, profileId)
  const news = useAccountReconnected(provider, profileId)
  const startError = useQuery<ReconnectStartError | null>({ queryKey: startErrorKey(provider, profileId), queryFn: NEVER, enabled: false, staleTime: Infinity }).data ?? null
  const profiles = useAgentProfiles().data?.profiles
  const profile = profiles?.find((row) => row.provider === provider && row.id === profileId)
  const account = profile?.label ?? (profileId === 'default' ? 'Default' : profileId)
  const who = `${agentName(provider)} · ${account}`
  const remote = useHealth().data?.capabilities?.localHandoff === false || isPhone()
  const narrow = useMediaQuery(NARROW_QUERY)
  const start = useStartLoginSession()
  const cancel = useCancelLoginSession()
  const recheck = useRecheckAgentAccount()
  const setStartError = (value: ReconnectStartError | null) => queryClient.setQueryData(startErrorKey(provider, profileId), value)

  const view: ReconnectView = startError ? 'failed'
    : isActiveLoginSession(session) ? 'signing'
    : session?.phase === 'connected' ? 'success'
    : session?.phase === 'failed' ? 'failed'
    : 'expired'

  const reconnect = (method?: LoginMethod) => {
    setStartError(null)
    // Never opens a browser: the link is shown to copy, so the user picks the profile (spec 2026-11-24).
    start.mutate(
      { provider, ...(profileId !== 'default' ? { profileId } : {}), ...(method ? { method } : {}) },
      {
        onError: (error) => setStartError({
          message: error.message,
          ...(error instanceof ApiError && error.command ? { command: error.command } : {}),
        }),
      },
    )
  }

  const checkAgain = () => {
    recheck.mutate(profileId !== 'default' ? profileId : `default:${provider}`, {
      onSuccess: (answer) => {
        if (answer.status.status === 'connected') toast(`${who} is signed in. Resuming what waited on it…`)
        else toast(`${who} is still signed out. Finish the sign-in, then check again.`)
      },
      onError: (error) => toast(error.message, { tone: 'danger' }),
    })
  }

  const stop = () => {
    if (session) cancel.mutate(session)
    else clearLoginSession(queryClient, provider, profileId)
    setStartError(null)
  }

  return { session, news, startError, profiles, profile, account, who, remote, narrow, view, start, recheck, reconnect, checkAgain, stop }
}

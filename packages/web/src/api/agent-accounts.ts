import { useQueryClient } from '@tanstack/react-query'
import { agentAccountRouteId, type Runner } from '@open-mercato/cezar-api-client'

import { getAgentAccountStatus } from '@/api/client'
import { useAgentAccountStatus, useAgentProfiles, useRepo, workspaceQueryKeys } from '@/api/queries'
import type { RunnerAccountChoice } from '@/components/picker-pill'
import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/**
 * The agent accounts a runner pill needs (spec 2026-07-29-agent-profiles), in ONE place.
 *
 * Every surface that offers "which agent, and which of its logins" asks the same two questions —
 * what logins exist, and which one this project falls back to — and answering them separately is
 * how the /new composer, the GitHub hand-off and the thread's Continue drift into three pills that
 * look alike and pick differently.
 */
export interface AgentAccountChoices {
  /** Every login for every runner, discovered accounts included. Empty = the zero-config host,
   *  which is why it renders as the single-row-per-agent list it always did. */
  accounts: readonly RunnerAccountChoice[]
  /** What the active project's selection resolves to per runner — the row selected until the
   *  surface's own override replaces it. */
  repoAccount?: Partial<Record<Runner, string>>
}

export function useAgentAccounts(): AgentAccountChoices {
  const profiles = useAgentProfiles()
  const repo = useRepo()
  const accounts = (profiles.data?.profiles ?? []).map((profile) => ({
    provider: profile.provider as Runner,
    id: profile.id,
    label: profile.label,
    configDir: profile.configDir,
  }))
  // Selections are keyed by the project's realpath'd ROOT — the key the store itself uses — and
  // `useRepo` is project-scoped, so it already answers for the ACTIVE project; going through the
  // projects list would mean re-deriving a mapping the API has already done.
  const repoRoot = repo.data?.info?.root
  return {
    accounts,
    repoAccount: resolveRepoAccounts(
      repoRoot ? profiles.data?.selections?.[repoRoot] : undefined,
      profiles.data?.defaults,
    ),
  }
}

/**
 * What an untouched pick resolves to per runner: the repo's own selection, else the machine-wide
 * default — the order the server's `selectionFor` resolves in. Leaving the machine-wide default out
 * made the pill read "claude · Default" in a repo with no selection of its own while the server ran
 * the task on the machine-wide account instead.
 */
export function resolveRepoAccounts(
  selection: Partial<Record<string, string>> | undefined,
  defaults: Partial<Record<string, string>> | undefined,
): Partial<Record<Runner, string>> | undefined {
  const resolved: Partial<Record<string, string>> = {}
  for (const source of [defaults, selection]) {
    for (const [runner, account] of Object.entries(source ?? {})) {
      if (account) resolved[runner] = account
    }
  }
  return Object.keys(resolved).length > 0 ? (resolved as Partial<Record<Runner, string>>) : undefined
}

/** The server gate's refusal for a signed-out named account (`signedOutAccountMessage` in
 *  `provider-action-gate.ts`), word for word. */
export function signedOutAccountMessage(runner: Runner, account: string): string {
  return `${PROVIDER_LABELS[runner]} account "${account.replace(/"/g, '')}" is not signed in. Sign it in under Settings → Agent accounts, or choose another account for this task.`
}

export interface SelectedAccountCheck {
  /** Why a task on this account cannot start, or null when nothing says so. */
  blocked: string | null
  /** Re-probe before refusing, as the server does: the reason that survives a fresh answer. */
  verify: () => Promise<string | null>
}

/**
 * Judge the NAMED account a task will run on, the way the server's gate does (telemetry ac53a6ef).
 *
 * `GET /providers/status` answers for the discovered login only, so a project on a signed-out
 * "Work" account looked startable and every Start came back as a 409. Only a probe's answer
 * blocks — the listing's cached status can be arbitrarily old — and never a pending or failed
 * one: the server stays the boundary.
 */
export function useSelectedAccountCheck(
  runner: Runner,
  accountId: string | null | undefined,
): SelectedAccountCheck {
  const queryClient = useQueryClient()
  const profiles = useAgentProfiles()
  const account = profiles.data?.profiles.find(
    (profile) => profile.provider === runner && profile.id === accountId && !profile.isDefault,
  )
  const routeId = account ? agentAccountRouteId(account) : ''
  const listed = account?.status
  const probed = useAgentAccountStatus(routeId, account !== undefined && listed?.status !== 'connected')
  const status = probed.data?.status ?? (listed?.status === 'connected' ? listed : undefined)
  const reasonFor = (state: string | undefined) =>
    account && state !== undefined && state !== 'connected'
      ? signedOutAccountMessage(runner, account.label || account.id)
      : null
  return {
    blocked: reasonFor(status?.status),
    verify: async () => {
      if (!account) return null
      try {
        const answer = await getAgentAccountStatus(routeId, { refresh: true })
        queryClient.setQueryData(workspaceQueryKeys.agentAccountStatus(routeId), answer)
        return reasonFor(answer.status.status)
      } catch {
        return null
      }
    },
  }
}

/** Does `runner` have a choice of login to make at all? One login is not a choice. */
export function hasAccountChoice(
  accounts: readonly RunnerAccountChoice[],
  runner: Runner,
): boolean {
  return accounts.filter((choice) => choice.provider === runner).length > 1
}

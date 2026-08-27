import type { Runner } from '@open-mercato/cezar-api-client'

import { useAgentProfiles, useRepo } from '@/api/queries'
import type { RunnerAccountChoice } from '@/components/picker-pill'

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
    repoAccount: (repoRoot ? profiles.data?.selections?.[repoRoot] : undefined) as
      | Partial<Record<Runner, string>>
      | undefined,
  }
}

/** Does `runner` have a choice of login to make at all? One login is not a choice. */
export function hasAccountChoice(
  accounts: readonly RunnerAccountChoice[],
  runner: Runner,
): boolean {
  return accounts.filter((choice) => choice.provider === runner).length > 1
}

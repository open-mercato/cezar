import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client'
import type { ApiRun, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { ApiError } from '@/api/client'
import { useAgentAccounts, useSelectedAccountCheck } from '@/api/agent-accounts'
import { canUseAgent } from '@/lib/agent-providers'
import { useAgentProviders, useProviderStatus } from '@/api/queries'
import { providerRowRunnable, providerStatusFor } from '@/lib/provider-status'

const PROVIDER_LABEL: Record<Runner, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  junie: 'Junie',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'pi',
  copilot: 'GitHub Copilot CLI',
  omp: 'OMP',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
  kimi: 'Kimi Code',
}

/** Mirrors the server's providerForActiveRun for POST /runs/:id/messages. */
export function providerForActiveRun(run: ApiRun): Runner {
  const current = run.currentStepId
    ? run.steps.find((step) => step.id === run.currentStepId)
    : undefined
  if (current?.backend) return current.backend
  if (run.runner) return run.runner
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const backend = run.steps[index]?.backend
    if (backend) return backend
  }
  return 'claude'
}

/** Mirrors the server's providerForExistingRun for an override-free POST /continue. */
export function providerForExistingRun(run: ApiRun): Runner {
  return run.runner ?? 'claude'
}

/** Match the affinity used by the server's recordedMethodFor and recordedProfileFor. */
function recordedBinding(run: ApiRun, runner: Runner) {
  const current = providerForExistingRun(run)
  const steps = [...run.steps].reverse().filter(step => (step.backend ?? current) === runner)
  return {
    method: steps.find(step => step.agentMethod)?.agentMethod ?? (runner === current ? run.agentMethod : undefined),
    profile: steps.find(step => step.profileId)?.profileId ?? (runner === current ? run.agentProfile : undefined),
  }
}

export function useRunProviderStatus(
  run: ApiRun,
  provider: Runner,
  options: { account?: string | null; replay?: boolean; projectId?: string } = {},
) {
  const status = useProviderStatus()
  const methods = useAgentProviders()
  const { accounts, repoAccount, pending: accountsPending } = useAgentAccounts(options.projectId)
  const binding = options.replay !== false ? recordedBinding(run, provider) : undefined
  const entries = methods.data?.nativeAuth ? undefined : methods.data?.agents
  const entry = entries?.find(agent => agent.runner === provider)
  const method = binding?.method ?? entry?.active
  // A replay on a managed key goes to the engine even if that key was removed. The engine
  // can park for repair; reopening on a different provider would lose the session's affinity.
  const replayKey = !!binding?.method && ['openrouter', 'apiKey', 'custom'].includes(binding.method)
  const usesLogin = !replayKey && (!method || method === 'subscription' || entry?.methods.find(m => m.id === method)?.kind === 'subscription')
  const accountId = options.account ?? binding?.profile ?? repoAccount?.[provider]
  const account = useSelectedAccountCheck(provider, usesLogin ? accountId : undefined)
  const namedAccount = !!accountId && accountId !== DEFAULT_AGENT_ACCOUNT_ID
  const row = providerStatusFor(status.data, provider)
  const bound = !!(binding?.method || namedAccount) && !!row?.enabled && row.status !== 'not-installed'
  const runners = (status.data?.providers ?? []).filter(row => {
    if (!row.enabled || row.status === 'not-installed') return false
    if (row.provider === provider) {
      const pinned = methods.data?.nativeAuth ? undefined : binding?.method
      return replayKey || (!account.blocked && canUseAgent(entry, row, { namedAccount: usesLogin && namedAccount, pinned }))
    }
    const other = entries?.find(agent => agent.runner === row.provider)
    const named = accounts.find(a => a.provider === row.provider && a.id === repoAccount?.[row.provider] && !a.isDefault)
    return canUseAgent(other, row, { namedAccount: named?.status?.status === 'connected' })
  }).map(row => row.provider)
  const legacy = methods.error instanceof ApiError && methods.error.status === 404
  return {
    data: status.data,
    runners,
    isPending: status.isPending || methods.isPending || accountsPending,
    isError: status.isError || (!replayKey && methods.isError && !methods.data && !legacy),
    accounts,
    repoAccount,
    accountId,
    bound,
    accountReason: account.blocked,
  }
}

function providerAvailability(
  provider: Runner,
  status: ProviderStatusResponse,
  usable?: boolean,
): { provider: Runner; usable: boolean; reason?: string } {
  const row = providerStatusFor(status, provider)
  if (row?.enabled === false) {
    return {
      provider,
      usable: false,
      reason: `${PROVIDER_LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`,
    }
  }
  if (!row || !(usable ?? providerRowRunnable(row))) {
    return {
      provider,
      usable: false,
      reason: `${PROVIDER_LABEL[provider]} credentials are unavailable. Authorize it in Settings → Agents → Providers.`,
    }
  }
  return { provider, usable: true }
}

export function activeProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
  usable?: boolean,
): { provider: Runner; usable: boolean; reason?: string } {
  return providerAvailability(providerForActiveRun(run), status, usable)
}

export function existingProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
  usable?: boolean,
): { provider: Runner; usable: boolean; reason?: string } {
  return providerAvailability(providerForExistingRun(run), status, usable)
}

/** Availability for the same provider the server will use for a live/queued message. */
export function useActiveProviderAvailability(run: ApiRun, projectId?: string) {
  const provider = providerForActiveRun(run)
  const status = useRunProviderStatus(run, provider, { projectId })
  // Do not strand an existing task while the availability query is loading or retrying; the
  // server remains the boundary for a stale client. Once a complete response arrives, mirror
  // its fixed action gate exactly.
  return !status.isPending && !status.isError && status.data
    ? activeProviderAvailability(run, status.data, status.runners.includes(provider))
    : { provider, usable: true }
}

/** Availability for the run's recorded provider, which an override-free continuation keeps.
 *  Optimistic while status loads, like the live gate — the server refuses a bad resume (#719). */
export function useExistingProviderAvailability(run: ApiRun, projectId?: string) {
  const provider = providerForExistingRun(run)
  const status = useRunProviderStatus(run, provider, { projectId })
  if (!status.isPending && !status.isError && status.data) return existingProviderAvailability(run, status.data, status.runners.includes(provider))
  if (status.isError) {
    return {
      provider,
      usable: false,
      reason: 'Provider authentication could not be verified.',
    }
  }
  return { provider, usable: true }
}

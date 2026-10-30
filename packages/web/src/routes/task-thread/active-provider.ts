import { supportsLlmProvider, type ApiRun, type LlmProvidersResponse, type ProviderStatusResponse, type Runner } from '@open-mercato/cezar-api-client'
import { useLlmProviders } from '@/api/llm-providers'
import { useProviderStatus } from '@/api/queries'
import { providerStatusFor } from '@/lib/provider-status'

const PROVIDER_LABEL: Record<Runner, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  junie: 'Junie',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'pi',
  copilot: 'GitHub Copilot CLI',
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

function providerAvailability(
  provider: Runner,
  status: ProviderStatusResponse,
  connectionId?: string,
  connections: LlmProvidersResponse['providers'] = [],
): { provider: Runner; usable: boolean; reason?: string } {
  const row = providerStatusFor(status, provider)
  if (row?.enabled === false) {
    return {
      provider,
      usable: false,
      reason: `${PROVIDER_LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`,
    }
  }
  if (connectionId) {
    const connection = connections.find(candidate => candidate.id === connectionId)
    if (!row || row.status === 'not-installed') {
      return { provider, usable: false, reason: 'The selected agent must be installed and enabled.' }
    }
    if (!connection?.hasApiKey || !supportsLlmProvider(provider, connection)) {
      return { provider, usable: false, reason: 'Selected LLM provider is unavailable. Choose a connection explicitly.' }
    }
    return { provider, usable: true }
  }
  if (row?.status !== 'connected') {
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
  connections?: LlmProvidersResponse['providers'],
): { provider: Runner; usable: boolean; reason?: string } {
  const provider = providerForActiveRun(run)
  return providerAvailability(provider, status, provider === run.runner ? run.llmProviderId : undefined, connections)
}

export function existingProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
  connections?: LlmProvidersResponse['providers'],
): { provider: Runner; usable: boolean; reason?: string } {
  const provider = providerForExistingRun(run)
  return providerAvailability(provider, status, provider === run.runner ? run.llmProviderId : undefined, connections)
}

/** Availability for the same provider the server will use for a live/queued message. */
export function useActiveProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const connections = useLlmProviders()
  const provider = providerForActiveRun(run)
  // Do not strand an existing task while the availability query is loading or retrying; the
  // server remains the boundary for a stale client. Once a complete response arrives, mirror
  // its fixed action gate exactly.
  return status.isSuccess && status.data
    ? activeProviderAvailability(run, status.data, connections.data?.providers)
    : { provider, usable: true }
}

/** Availability for the run's recorded provider, which an override-free continuation keeps. */
export function useExistingProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const connections = useLlmProviders()
  const provider = providerForExistingRun(run)
  if (status.isSuccess && status.data) return existingProviderAvailability(run, status.data, connections.data?.providers)
  if (status.isError) {
    return {
      provider,
      usable: false,
      reason: 'Provider authentication could not be verified.',
    }
  }
  return {
    provider,
    usable: false,
    reason: 'Checking agent providers…',
  }
}

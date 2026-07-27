import type { ApiRun, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { useProviderStatus } from '@/api/queries'
import { providerStatusFor } from '@/lib/provider-status'

const PROVIDER_LABEL: Record<Runner, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
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

export function activeProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
): { provider: Runner; usable: boolean; reason?: string } {
  const provider = providerForActiveRun(run)
  const row = providerStatusFor(status, provider)
  if (row?.enabled === false) {
    return {
      provider,
      usable: false,
      reason: `${PROVIDER_LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`,
    }
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

/** Availability for the same provider the server will use for a live/queued message. */
export function useActiveProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const provider = providerForActiveRun(run)
  // Do not strand an existing task while the availability query is loading or retrying; the
  // server remains the boundary for a stale client. Once a complete response arrives, mirror
  // its fixed action gate exactly.
  return status.isSuccess && status.data
    ? activeProviderAvailability(run, status.data)
    : { provider, usable: true }
}

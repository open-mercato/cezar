import type { ProviderStatus, ProviderStatusResponse, Runner } from '@/api/types'

const RUNNER_ORDER: readonly Runner[] = ['claude', 'codex', 'opencode']

export function connectedRunners(status: ProviderStatusResponse | undefined): Runner[] {
  if (!status || !Array.isArray(status.providers)) return []
  const connected = new Set(
    status.providers
      .filter((row) => row.status === 'connected')
      .map((row) => row.provider),
  )
  return RUNNER_ORDER.filter((runner) => connected.has(runner))
}

export function providerStatusFor(
  status: ProviderStatusResponse | undefined,
  provider: Runner,
): ProviderStatus | undefined {
  return status?.providers.find((row) => row.provider === provider)
}

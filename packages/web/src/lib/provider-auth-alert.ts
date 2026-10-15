import type {
  ProviderId,
  ProviderStatusResponse,
  WorkspaceUiState,
} from '@open-mercato/cezar-api-client'

import { RUNNER_ORDER } from './provider-status'

// One row per contract runner, in the cockpit's order — `RUNNER_ORDER` is exhaustive over the
// contract, so an incident for a new runner cannot be silently dropped here.
const PROVIDERS: readonly ProviderId[] = RUNNER_ORDER
const LABELS: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'pi',
  junie: 'Junie',
  copilot: 'GitHub Copilot CLI',
  omp: 'OMP',
}

export interface ProviderAuthIncident {
  provider: ProviderId
  label: string
  authFailureId: string
}

export type ProviderAuthDismissals = NonNullable<
  WorkspaceUiState['dismissedProviderAuthFailures']
>

export function providerAuthDismissals(value: unknown): ProviderAuthDismissals {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const dismissals: ProviderAuthDismissals = {}
  for (const provider of PROVIDERS) {
    const id = record[provider]
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      dismissals[provider] = id
    }
  }
  return dismissals
}

export function visibleProviderAuthIncidents(
  status: ProviderStatusResponse | undefined,
  dismissals: ProviderAuthDismissals,
): ProviderAuthIncident[] {
  if (!status) return []
  const rows = new Map(status.providers.map((row) => [row.provider, row]))
  return PROVIDERS.flatMap((provider) => {
    const row = rows.get(provider)
    if (
      row?.status !== 'disconnected'
      || !row.authFailureId
      || dismissals[provider] === row.authFailureId
    ) return []
    return [{
      provider,
      label: LABELS[provider],
      authFailureId: row.authFailureId,
    }]
  })
}

export function mergeProviderAuthDismissals(
  current: ProviderAuthDismissals,
  incidents: readonly ProviderAuthIncident[],
): ProviderAuthDismissals {
  return {
    ...current,
    ...Object.fromEntries(incidents.map(({ provider, authFailureId }) => [
      provider,
      authFailureId,
    ])),
  }
}

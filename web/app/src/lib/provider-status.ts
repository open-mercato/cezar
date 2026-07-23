import type { ProviderStatus, ProviderStatusResponse, Runner } from '@/api/types'

const RUNNER_ORDER: readonly Runner[] = ['claude', 'codex', 'opencode']
const PROVIDER_STATES = new Set(['connected', 'disconnected', 'not-installed', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseProviderStatusRow(value: unknown): ProviderStatus | null {
  if (!isRecord(value)) return null
  const { provider, status, hint, authFailureId } = value
  if (
    typeof provider !== 'string'
    || !RUNNER_ORDER.includes(provider as Runner)
    || typeof status !== 'string'
    || !PROVIDER_STATES.has(status)
    || (hint !== undefined && typeof hint !== 'string')
    || (
      authFailureId !== undefined
      && (
        typeof authFailureId !== 'string'
        || authFailureId.length < 1
        || authFailureId.length > 128
        || status !== 'disconnected'
      )
    )
  ) return null
  return {
    provider: provider as Runner,
    status: status as ProviderStatus['status'],
    ...(hint === undefined ? {} : { hint }),
    ...(authFailureId === undefined ? {} : { authFailureId }),
  }
}

function safeProviderRows(value: unknown): ProviderStatus[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null
  const rows: ProviderStatus[] = []
  const seen = new Set<string>()
  for (const valueRow of value.providers) {
    const row = parseProviderStatusRow(valueRow)
    if (row === null || seen.has(row.provider)) return null
    seen.add(row.provider)
    rows.push(row)
  }
  return rows
}

function completeProviderRows(value: unknown): ProviderStatus[] | null {
  const rows = safeProviderRows(value)
  if (rows === null || rows.length !== RUNNER_ORDER.length) return null
  const byProvider = new Map(rows.map((row) => [row.provider, row]))
  if (RUNNER_ORDER.some((provider) => !byProvider.has(provider))) return null
  return RUNNER_ORDER.map((provider) => byProvider.get(provider)!)
}

export function parseProviderStatusResponse(value: unknown): ProviderStatusResponse {
  const rows = completeProviderRows(value)
  if (rows === null) {
    throw new Error('Invalid provider status response')
  }
  return { providers: rows }
}

export function applyProviderStatusRow(
  response: ProviderStatusResponse | undefined,
  row: ProviderStatus,
): ProviderStatusResponse | undefined {
  const providers = completeProviderRows(response)
  if (providers === null) return undefined
  return {
    providers: providers.map((candidate) =>
      candidate.provider === row.provider ? row : candidate),
  }
}

export function connectedRunners(status: ProviderStatusResponse | undefined): Runner[] {
  const rows = completeProviderRows(status)
  if (rows === null) return []
  const connected = new Set(
    rows
      .filter((row) => row.status === 'connected')
      .map((row) => row.provider),
  )
  return RUNNER_ORDER.filter((runner) => connected.has(runner))
}

export function providerStatusFor(
  status: ProviderStatusResponse | undefined,
  provider: Runner,
): ProviderStatus | undefined {
  return completeProviderRows(status)?.find((row) => row.provider === provider)
}

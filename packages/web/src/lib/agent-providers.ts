import type { AgentProviderEntry, AgentProviderMethod, ProviderStatus } from '@open-mercato/cezar-api-client'
import { providerRowRunnable } from './provider-status'

export const agentProvidersPath = (runner: string) => `/settings/global/agents#agent-${runner}`

/** Explicitly clearing a one-mode selection must survive a still-connected vendor login. */
export function servingMethods(entry: AgentProviderEntry): AgentProviderMethod[] {
  return entry.methods.filter(method =>
    (entry.mode === 'any' || entry.active === method.id || (entry.active === undefined && method.kind === 'subscription')) &&
    (method.state === 'connected' || (method.state === 'unknown' && providerRowRunnable({ provider: entry.runner, status: 'unknown' }))),
  )
}

export function canUseAgent(entry: AgentProviderEntry | undefined, login: ProviderStatus | undefined): boolean {
  if (!login?.enabled || login.status === 'not-installed') return false
  if (entry && servingMethods(entry).length > 0) return true
  // An offline login probe can establish that an agent runs without identifying its provider.
  return !entry?.configured && providerRowRunnable(login)
}

export function methodSummary(entry: AgentProviderEntry, login?: ProviderStatus): string {
  const serving = servingMethods(entry)
  if (!serving.length) return canUseAgent(entry, login) ? 'Provider unverified' : 'No provider'
  if (serving.every(m => m.state === 'unknown')) return 'Provider unverified'
  const connected = serving.filter(m => m.state === 'connected')
  return entry.mode === 'one' ? connected[0]!.label : `${connected.length} of ${entry.methods.length} connected`
}

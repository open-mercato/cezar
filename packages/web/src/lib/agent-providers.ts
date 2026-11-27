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
  if (entry?.configured) return servingMethods(entry).length > 0
  // An offline login probe can establish that an agent runs without identifying its provider.
  return providerRowRunnable(login) || !!entry && servingMethods(entry).length > 0
}

export function methodSummary(entry: AgentProviderEntry): string {
  const serving = servingMethods(entry)
  if (!serving.length) return entry.methods.some(m => m.state === 'unknown') ? 'Login unverified' : 'No provider'
  if (serving.some(m => m.state === 'unknown')) return 'Login unverified'
  return entry.mode === 'one' ? serving[0]!.label : `${serving.length} of ${entry.methods.length} connected`
}

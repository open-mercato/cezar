import type { AgentProviderEntry, AgentProviderMethod, ProviderStatus } from '@open-mercato/cezar-api-client'
import { providerRowRunnable } from './provider-status'

export const agentProvidersPath = (runner: string) => `/settings/global/agents#agent-${runner}`

export function selectableMethod(method: AgentProviderMethod): boolean {
  return method.state === 'connected' || (method.kind === 'subscription' && method.state === 'unknown' && method.verifyAtLaunch === true)
}

export function hasManagedCatalog(method: AgentProviderMethod): boolean {
  return (method.kind === 'custom' || method.kind === 'openrouter') && method.origin !== 'host' &&
    (!!method.origin || !!method.keyHint || method.state === 'error')
}

interface MethodSelection {
  namedAccount?: boolean
  pinned?: string
}

/** A named account's login is independent of the machine account shown in Settings. */
export function servingMethods(entry: AgentProviderEntry, { namedAccount, pinned }: MethodSelection = {}): AgentProviderMethod[] {
  return entry.methods.filter(method => {
    const selected = pinned ? pinned === method.id : entry.mode === 'any' || entry.active === method.id ||
      (entry.active === undefined && method.kind === 'subscription')
    if (!selected) return false
    return selectableMethod(method) || (method.kind === 'subscription' && namedAccount)
  })
}

export function canUseAgent(entry: AgentProviderEntry | undefined, login: ProviderStatus | undefined, selection: MethodSelection = {}): boolean {
  if (!login?.enabled || login.status === 'not-installed') return false
  const namedAccount = !!selection.namedAccount && !login.authFailureId
  if (entry && servingMethods(entry, { ...selection, namedAccount }).some(method =>
    method.state === 'connected' || namedAccount || login.status !== 'disconnected',
  )) return true
  // Without managed settings, the server judges the selected account's native login.
  return !selection.pinned && !entry?.configured && (providerRowRunnable(login) || namedAccount)
}

export function methodSummary(entry: AgentProviderEntry, login?: ProviderStatus): string {
  const serving = servingMethods(entry)
  if (!serving.length) return canUseAgent(entry, login) ? 'Provider unverified' : 'No provider'
  if (serving.every(m => m.state === 'unknown')) return 'Provider unverified'
  const connected = serving.filter(m => m.state === 'connected')
  return entry.mode === 'one' ? connected[0]!.label : `${connected.length} of ${entry.methods.length} connected`
}

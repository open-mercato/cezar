import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { AgentProfile, ProviderId } from '@open-mercato/cezar-api-client'

import { useAgentProfiles } from '@/api/queries'

import { AddAccountDialog } from './add-account-dialog'
import { AddAccountWizard } from './add-account-wizard'

/**
 * One Add-account wizard for the whole cockpit (spec 2026-11-24-add-account-in-cockpit): Settings,
 * the task and manager account pickers and the reconnect card all open the same one.
 */
export interface OpenAddAccount {
  provider?: ProviderId | undefined
  /** Finish the sign-in of a pending account. */
  resume?: AgentProfile | undefined
  /** The new account, once signed in (a picker selects it). */
  onAdded?: ((profile: AgentProfile) => void) | undefined
}

interface AddAccountApi {
  /** Agents that can carry a second account. */
  capable: readonly ProviderId[]
  open: (options?: OpenAddAccount) => void
}

const OpenContext = createContext<((options?: OpenAddAccount) => void) | null>(null)

/** Agents that can carry a second account here; empty while unknown or where accounts are off. */
const NONE: readonly ProviderId[] = []
function useCapable(): readonly ProviderId[] {
  const profiles = useAgentProfiles().data
  return profiles?.editable ? profiles.profileCapableProviders ?? NONE : NONE
}

/** Null outside the provider, or where accounts cannot be added; callers then offer nothing. */
export function useAddAccount(): AddAccountApi | null {
  const open = useContext(OpenContext)
  const capable = useCapable()
  return useMemo(() => (open && capable.length > 0 ? { capable, open } : null), [open, capable])
}

/** Holds only the open request: the accounts listing is fetched by whoever opens it, not at boot. */
export function AddAccountProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(OpenAddAccount & { key: number }) | null>(null)
  const [advanced, setAdvanced] = useState<ProviderId | null>(null)
  const open = useCallback((options: OpenAddAccount = {}) => setRequest({ ...options, key: Date.now() }), [])

  return (
    <OpenContext.Provider value={open}>
      {children}
      {request ? (
        <OpenWizard request={request} onClose={() => setRequest(null)} onAdvanced={(provider) => { setAdvanced(provider); setRequest(null) }} />
      ) : null}
      {advanced !== null ? <AdvancedDialog provider={advanced} onClose={() => setAdvanced(null)} /> : null}
    </OpenContext.Provider>
  )
}

function OpenWizard({ request, onClose, onAdvanced }: {
  request: OpenAddAccount & { key: number }
  onClose: () => void
  onAdvanced: (provider: ProviderId) => void
}) {
  const profiles = useAgentProfiles().data
  const capable = useCapable()
  if (!profiles) return null
  const hostPaths = profiles.hostPaths !== false
  const fallback = request.provider && capable.includes(request.provider) ? request.provider : capable[0]
  return (
    <AddAccountWizard
      key={request.key}
      open
      onOpenChange={(next) => !next && onClose()}
      providers={capable}
      initialProvider={request.provider}
      resume={request.resume}
      onAdded={request.onAdded}
      // The folder-path dialog needs host paths: never on a phone.
      onAdvanced={hostPaths && fallback ? () => onAdvanced(fallback) : undefined}
    />
  )
}

function AdvancedDialog({ provider, onClose }: { provider: ProviderId; onClose: () => void }) {
  const capable = useCapable()
  return <AddAccountDialog key={provider} open onOpenChange={(next) => !next && onClose()} providers={[...capable]} initialProvider={provider} />
}

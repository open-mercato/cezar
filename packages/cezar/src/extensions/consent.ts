import type { ExtensionRecord } from '@open-mercato/cezar-contract'
import { sourceIdentity } from './installer.ts'

/** A project's approval covers the installed artifact it names, or a later update that asks for
 *  nothing more — so a project that was not open during an update keeps its consent too. */
export function approved(approval: ExtensionRecord | undefined, record: ExtensionRecord): boolean {
  if (!approval?.enabled) return false
  const same = approval.integrity === record.integrity && approval.installedAt === record.installedAt
  return same || keepsConsent(approval, record)
}

type ConsentInput = Pick<ExtensionRecord, 'manifest' | 'source'>

export const addedPermissions = (old: ConsentInput | undefined, next: ConsentInput) =>
  next.manifest.permissions.filter(permission => !old?.manifest.permissions.includes(permission))

export const addedCapabilities = (old: ConsentInput | undefined, next: ConsentInput) =>
  next.manifest.capabilities.filter(capability => !old?.manifest.capabilities.includes(capability))

/** An update keeps a project's approval only when it comes from the same source and asks for
 *  nothing the approved version lacked. */
export function keepsConsent(old: (ConsentInput & { enabled: boolean }) | undefined, next: ConsentInput): boolean {
  if (!old?.enabled) return false
  const priorProviders = old.manifest.contributes?.chatProviders
  return sourceIdentity(old.source) === sourceIdentity(next.source)
    && addedPermissions(old, next).length === 0
    && addedCapabilities(old, next).length === 0
    && (next.manifest.contributes?.chatProviders ?? []).every(provider => priorProviders?.some(prior => prior.id === provider.id && prior.credentialProfile === provider.credentialProfile && prior.receiveModel === provider.receiveModel))
}

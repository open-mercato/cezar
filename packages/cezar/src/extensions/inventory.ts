import type { ExtensionInventoryItem, ExtensionRecord } from '@open-mercato/cezar-contract'
import type { CanonicalChatProvider, ChatSelectionTarget, UnreadableSelection } from './chat-selection-store.ts'
import type { ChatDeliveryArtifact } from './delivery-catalog.ts'
import { approved, isShippedApproval, shippedRecord } from './consent.ts'
import { isPackageSource } from './installer.ts'
import { isUnreadable, type UnreadableRecord } from './store.ts'

export type PinnedSelection = {
  provider: CanonicalChatProvider
  target: Extract<ChatSelectionTarget, { kind: 'installed' }>
  present: boolean
}
export type InventoryInput = {
  installed: ExtensionRecord[]
  saved: ExtensionRecord[]
  shipped: ChatDeliveryArtifact[]
  pinned: Map<string, PinnedSelection>
  hostVersion: string
  unavailable?: 'flag-disabled' | 'hosted' | undefined
  status: (id: string) => NonNullable<ExtensionRecord['status']>
  failed: (id: string) => boolean
  /** Stored state that no longer parses: shown as such, never read as a default. */
  lost?: { installs: UnreadableRecord[]; approvals: UnreadableRecord[]; selections: UnreadableSelection[] }
}

const UNREADABLE_RECORD = 'Stored extension record is unreadable; reinstall this extension'
const UNREADABLE_APPROVAL = 'Stored approval is unreadable; review and enable this extension again'

/** Metadata projection only: nothing here reconciles, leases or activates extension code. */
export function projectInventory(input: InventoryInput): ExtensionInventoryItem[] {
  const { installed, saved, shipped, pinned, hostVersion, unavailable, status, failed } = input
  const lost = input.lost ?? { installs: [], approvals: [], selections: [] }
  const records = new Map(saved.map(record => [record.manifest.id, record]))
  const shippedRecords = new Set<string>()
  const shippedArtifacts = new Map(shipped.map(artifact => [artifact.extensionId, artifact]))
  for (const artifact of shipped) {
    if ([...pinned.values()].some(item => item.provider === artifact.provider)) {
      const old = records.get(artifact.extensionId)
      if (old && isShippedApproval(old)) records.delete(artifact.extensionId)
      continue
    }
    // An explicit installed selection is never replaced by a host update.
    const prior = records.get(artifact.extensionId)
    if (!prior || isShippedApproval(prior)) {
      shippedRecords.add(artifact.extensionId)
      records.set(artifact.extensionId, shippedRecord(artifact, prior?.enabled ?? !isUnreadable(lost.approvals, artifact.extensionId)))
    }
  }
  for (const [id, item] of pinned) records.set(id, item.target.record)
  const candidates = new Map<string, ExtensionRecord>()
  for (const record of installed) {
    const selected = pinned.get(record.manifest.id)
    if (selected) {
      if (selected.target.record.integrity !== record.integrity) candidates.set(record.manifest.id, record)
      continue
    }
    const selection = saved.find(item => item.manifest.id === record.manifest.id)
    if (shippedRecords.has(record.manifest.id) && selection && isShippedApproval(selection)) candidates.set(record.manifest.id, record)
    else {
      records.set(record.manifest.id, record)
      shippedRecords.delete(record.manifest.id)
    }
  }
  const projectArtifact = (record: ExtensionRecord, candidate = false): Omit<ExtensionInventoryItem, 'installedCandidate'> => {
    const id = record.manifest.id
    const artifact = !candidate && shippedRecords.has(id) ? shippedArtifacts.get(id) : undefined
    const selected = !candidate ? pinned.get(id) : undefined
    const globallyInstalled = installed.some(item => item.manifest.id === id)
    const present = selected ? selected.present : !!artifact || globallyInstalled
    const approval = saved.find(item => item.manifest.id === id)
    const lostSelection = candidate ? undefined : lost.selections.find(item => item.extensionId === id || item.provider === artifact?.provider)
    const lostApproval = !candidate && !approval && isUnreadable(lost.approvals, id)
    const enabled = !candidate && present && !lostSelection && (artifact ? record.enabled : approved(approval, record))
    const problem = lostSelection?.message.slice(0, 500) ?? (lostApproval ? UNREADABLE_APPROVAL : undefined)
    const source = record.source
    const kind = isPackageSource(source) ? 'npm' as const : 'folder' as const
    const availability = unavailable === 'hosted' || (unavailable === 'flag-disabled' && !artifact) ? unavailable : undefined
    return {
      record: { ...record, enabled, status: candidate ? 'disabled' : status(id), ...(problem ? { error: problem } : {}) },
      provenance: artifact ? { kind: 'bundled' as const, hostVersion, integrity: artifact.integrity } : { kind, source },
      availability: availability ?? (!present ? 'missing' : problem ? 'failed' : !enabled ? 'disabled' : failed(id) ? 'failed' : 'available'),
      selectedVersion: record.manifest.version,
      management: {
        // A failed worker stays enabled; enabling it again is the retry.
        enable: !candidate && present && !lostSelection && (!enabled || failed(id)) && !availability,
        disable: present && enabled && !availability,
        update: globallyInstalled && present && !artifact && !availability,
        uninstall: globallyInstalled && present && !artifact && !availability,
      },
      providers: (record.manifest.contributes?.chatProviders ?? []).map(provider => ({
        id: artifact ? artifact.provider : selected?.target.localProviderId === provider.id ? selected.provider : `${id}/${provider.id}`,
        label: provider.label,
      })),
    }
  }
  const items: ExtensionInventoryItem[] = [...records.values()].map(record => {
    const candidate = candidates.get(record.manifest.id)
    return { ...projectArtifact(record), ...(candidate ? { installedCandidate: projectArtifact(candidate, true) } : {}) }
  })
  // A row that cannot be parsed still names what is missing; nothing about it can run or be managed.
  const named = new Map([...lost.installs, ...lost.approvals].flatMap(row => row.id && !records.has(row.id) ? [[row.id, row] as const] : []))
  for (const [id, row] of named) items.push(unreadableItem(id, row))
  return items
}

function unreadableItem(id: string, row: UnreadableRecord): ExtensionInventoryItem {
  const version = row.version ?? 'unknown', source = row.source ?? 'unknown'
  return {
    record: {
      manifest: { id, name: row.name ?? id, version, apiVersion: '0.1', entry: 'unreadable', capabilities: [], permissions: [] },
      source, installedAt: 'unknown', enabled: false, status: 'failed', error: UNREADABLE_RECORD,
    },
    provenance: { kind: row.source && isPackageSource(row.source) ? 'npm' : 'folder', source },
    availability: 'failed',
    selectedVersion: version,
    management: { enable: false, disable: false, update: false, uninstall: false },
    providers: [],
  }
}

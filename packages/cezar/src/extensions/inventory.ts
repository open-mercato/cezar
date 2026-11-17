import type { ExtensionInventoryItem, ExtensionRecord } from '@open-mercato/cezar-contract'
import { approved } from './consent.ts'
import { isPackageSource } from './installer.ts'
import { isUnreadable, type UnreadableRecord } from './store.ts'

export type InventoryInput = {
  installed: ExtensionRecord[]
  saved: ExtensionRecord[]
  unavailable?: 'flag-disabled' | 'hosted' | undefined
  status: (id: string) => NonNullable<ExtensionRecord['status']>
  failed: (id: string) => boolean
  /** Stored state that no longer parses: shown as such, never read as a default. */
  lost?: { installs: UnreadableRecord[]; approvals: UnreadableRecord[] }
}

const UNREADABLE_RECORD = 'Stored extension record is unreadable; reinstall this extension'
const UNREADABLE_APPROVAL = 'Stored approval is unreadable; review and enable this extension again'

/** Metadata projection only: nothing here reconciles, leases or activates extension code. */
export function projectInventory(input: InventoryInput): ExtensionInventoryItem[] {
  const { installed, saved, unavailable, status, failed } = input
  const lost = input.lost ?? { installs: [], approvals: [] }
  const records = new Map(saved.map(record => [record.manifest.id, record]))
  for (const record of installed) records.set(record.manifest.id, record)
  const items: ExtensionInventoryItem[] = [...records.values()].map(record => {
    const id = record.manifest.id
    const present = installed.some(item => item.manifest.id === id)
    const approval = saved.find(item => item.manifest.id === id)
    const lostApproval = !approval && isUnreadable(lost.approvals, id)
    const enabled = present && approved(approval, record)
    const problem = lostApproval ? UNREADABLE_APPROVAL : undefined
    const source = record.source
    const kind = isPackageSource(source) ? 'npm' as const : 'folder' as const
    return {
      record: { ...record, enabled, status: status(id), ...(problem ? { error: problem } : {}) },
      provenance: { kind, source },
      availability: unavailable ?? (!present ? 'missing' : problem ? 'failed' : !enabled ? 'disabled' : failed(id) ? 'failed' : 'available'),
      selectedVersion: record.manifest.version,
      management: {
        // A failed worker stays enabled; enabling it again is the retry.
        enable: present && (!enabled || failed(id)) && !unavailable,
        disable: present && enabled && !unavailable,
        update: present && !unavailable,
        uninstall: present && !unavailable,
      },
      providers: (record.manifest.contributes?.chatProviders ?? []).map(provider => ({ id: `${id}/${provider.id}`, label: provider.label })),
    }
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

import type { AccountUsageEntry } from '@open-mercato/cezar-api-client'

/** Chip order: by provider, named accounts before the default, then by label. */
export function sortAccountUsageEntries(entries: readonly AccountUsageEntry[]): AccountUsageEntry[] {
  return [...entries].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1
    return a.label.localeCompare(b.label)
  })
}

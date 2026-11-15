import type { AccountUsageEntry } from '@open-mercato/cezar-api-client'

/** Prefer the route's rows when the listing is still warming: one chip per route id. */
export function mergeAccountUsageEntries(
  listed: readonly AccountUsageEntry[],
  fetched: AccountUsageEntry[] | undefined,
): AccountUsageEntry[] {
  const byRoute = new Map<string, AccountUsageEntry>()
  for (const entry of fetched ?? []) byRoute.set(entry.routeId, entry)
  const source = fetched?.length ? [...byRoute.values()] : [...listed]
  return source.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1
    return a.label.localeCompare(b.label)
  })
}

export function isAccountUsageStale(observedAtIso: string, now: number, staleMs: number): boolean {
  const at = Date.parse(observedAtIso)
  return Number.isFinite(at) && now - at > staleMs
}
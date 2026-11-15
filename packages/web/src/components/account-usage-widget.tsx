import { useMemo } from 'react'

import { getAgentAccountDetails } from '@/api/client'
import { useHostTransport } from '@/api/host-usage'
import { useAccountUsage, useHealth, workspaceQueryKeys } from '@/api/queries'
import { accountPart, COCKPIT_USAGE_STALE_MS, LiveUsage, liveUsageParts } from '@/components/live-usage'
import { useLiveUsageEnabled } from '@/lib/live-usage-pref'
import { mergeAccountUsageEntries } from '@/lib/account-usage-selection'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'
import type { AccountUsageEntry } from '@open-mercato/cezar-api-client'
import { useQuery } from '@tanstack/react-query'

export function AccountUsageWidget() {
  const desktop = useIsDesktop()
  const transport = useHostTransport()
  const enabled = useLiveUsageEnabled()
  if (!desktop || transport !== 'local' || !enabled) return null
  return <AccountUsageWidgetBody />
}

function AccountUsageWidgetBody() {
  const usage = useAccountUsage()
  const rows = useMemo(
    () => mergeAccountUsageEntries(usage.data?.accounts ?? [], usage.data?.accounts),
    [usage.data?.accounts],
  )
  const visible = rows.filter((entry) => liveUsageParts(entry.usage, Date.now(), { fraction: 'used' }).length > 0)
  if (!visible.length) return null
  return (
    <div
      data-slot="account-usage-widget"
      className="mx-2.5 mb-1.5 flex min-w-0 flex-col gap-1 border-t border-border pt-1.5"
    >
      {visible.map((entry) => (
        <AccountUsageChip key={entry.routeId} entry={entry} />
      ))}
    </div>
  )
}

function AccountUsageChip({ entry }: { entry: AccountUsageEntry }) {
  const local = useHealth().data?.capabilities?.localHandoff ?? true
  const details = useQuery({
    queryKey: workspaceQueryKeys.agentAccountDetails(entry.routeId),
    queryFn: ({ signal }) => getAgentAccountDetails(entry.routeId, { signal }),
    enabled: local,
    staleTime: 5 * 60_000,
    retry: false,
  }).data
  const org = accountPart(details)
  const label = entry.label.trim() || org?.text || entry.routeId
  const account = {
    text: label,
    tone: 'neutral' as const,
    ...(local && org?.title ? { title: org.title } : {}),
  }
  return (
    <div
      data-slot="account-usage-chip"
      data-provider={entry.provider}
      className={cn('min-w-0 truncate rounded-md border border-border bg-card/60 px-2 py-1 text-meta text-muted-foreground')}
    >
      <LiveUsage
        usage={entry.usage}
        account={account}
        fraction="used"
        staleMs={COCKPIT_USAGE_STALE_MS}
        staleLabel="seen-ago"
        className="block min-w-0 truncate"
      />
    </div>
  )
}
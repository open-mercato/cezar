import { useContext, useMemo } from 'react'

import { getAgentAccountDetails } from '@/api/client'
import { useHostTransport } from '@/api/host-usage'
import { useAccountUsage, useAgentProfiles, useHealth, workspaceQueryKeys } from '@/api/queries'
import { accountPart, COCKPIT_USAGE_STALE_MS, LiveUsage, liveUsageParts, type LiveUsageFraction } from '@/components/live-usage'
import { useLiveUsageEnabled } from '@/lib/live-usage-pref'
import { mergeAccountUsageEntries } from '@/lib/account-usage-selection'
import { cn } from '@/lib/utils'
import { agentAccountRouteId, type AccountUsageEntry } from '@open-mercato/cezar-api-client'
import { QueryClientContext, useQuery } from '@tanstack/react-query'

export interface AccountUsageWidgetProps {
  runner?: string
  agentProfile?: string
  className?: string
  fraction?: LiveUsageFraction
}

export function AccountUsageWidget({
  runner,
  agentProfile,
  className,
  fraction = 'used',
}: AccountUsageWidgetProps = {}) {
  const queryClient = useContext(QueryClientContext)
  if (!queryClient) return null
  const transport = useHostTransport()
  const enabled = useLiveUsageEnabled()
  if (transport !== 'local' || !enabled) return null
  return (
    <AccountUsageWidgetBody
      runner={runner}
      agentProfile={agentProfile}
      className={className}
      fraction={fraction}
    />
  )
}

function AccountUsageWidgetBody({
  runner,
  agentProfile,
  className,
  fraction,
}: {
  runner?: string
  agentProfile?: string
  className?: string
  fraction: LiveUsageFraction
}) {
  const usage = useAccountUsage()
  const profiles = useAgentProfiles()
  const rows = useMemo(
    () => mergeAccountUsageEntries(usage.data?.accounts ?? []),
    [usage.data?.accounts],
  )
  const isFiltered = Boolean(runner || agentProfile)
  const visible = useMemo(() => {
    if (!isFiltered) {
      return rows.filter((entry) => liveUsageParts(entry.usage, Date.now(), { fraction }).length > 0)
    }
    const targetRunner = runner ?? 'claude'
    const byRunner = rows.filter((entry) => entry.provider === targetRunner)
    if (byRunner.length > 0) {
      if (agentProfile) {
        const match = byRunner.find((entry) => entry.id === agentProfile)
        if (match) return [match]
      } else {
        const defaultAccount = byRunner.find((entry) => entry.isDefault) ?? byRunner[0]
        if (defaultAccount) return [defaultAccount]
      }
    }
    const profile = profiles.data?.profiles.find(
      (p) => p.provider === targetRunner && (agentProfile ? p.id === agentProfile : p.isDefault),
    )
    if (profile) {
      const syntheticEntry: AccountUsageEntry = {
        id: profile.id,
        provider: profile.provider as 'claude' | 'codex',
        label: profile.label,
        isDefault: profile.isDefault,
        routeId: agentAccountRouteId(profile),
        usage: { at: '', limits: [] },
      }
      return [syntheticEntry]
    }
    return []
  }, [rows, runner, agentProfile, isFiltered, profiles.data?.profiles, fraction])

  if (!visible.length) return null
  return (
    <div
      data-slot="account-usage-widget"
      className={cn(
        isFiltered
          ? 'flex min-w-0 items-center'
          : 'mx-2.5 mb-1.5 flex min-w-0 flex-col gap-1 border-t border-border pt-1.5',
        className,
      )}
    >
      {visible.map((entry) => (
        <AccountUsageChip key={entry.routeId} entry={entry} fraction={fraction} />
      ))}
    </div>
  )
}

export function AccountUsageChip({
  entry,
  fraction = 'used',
}: {
  entry: AccountUsageEntry
  fraction?: LiveUsageFraction
}) {
  const local = useHealth().data?.capabilities?.localHandoff === true
  const details = useQuery({
    queryKey: workspaceQueryKeys.agentAccountDetails(entry.routeId),
    queryFn: ({ signal }) => getAgentAccountDetails(entry.routeId, { signal }),
    enabled: local,
    staleTime: 5 * 60_000,
    retry: false,
  }).data
  const org = accountPart(details)
  const label = (entry.isDefault ? org?.text || entry.label.trim() : entry.label.trim()) || org?.text || entry.routeId
  const account = {
    text: label,
    tone: 'neutral' as const,
    ...(local && org?.title ? { title: org.title } : {}),
  }
  return (
    <div
      data-slot="account-usage-chip"
      data-provider={entry.provider}
      className={cn('min-w-0 truncate px-1 py-0.5 text-meta text-muted-foreground')}
    >
      <LiveUsage
        usage={entry.usage}
        account={account}
        fraction={fraction}
        staleMs={COCKPIT_USAGE_STALE_MS}
        staleLabel="seen-ago"
        layout="bracketed"
        className="block min-w-0 truncate"
      />
    </div>
  )
}

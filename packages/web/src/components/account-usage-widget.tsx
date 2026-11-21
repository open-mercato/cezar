import { useMemo } from 'react'

import { getAgentAccountDetails } from '@/api/client'
import { useHostTransport } from '@/api/host-usage'
import { useAccountUsage, useAgentProfiles, useHealth, workspaceQueryKeys } from '@/api/queries'
import { accountPart, COCKPIT_USAGE_STALE_MS, LiveUsage, liveUsageParts, peakUsage, type LiveUsageFraction, type LiveUsageTone } from '@/components/live-usage'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLiveUsageEnabled } from '@/lib/live-usage-pref'
import { sortAccountUsageEntries } from '@/lib/account-usage-selection'
import { cn } from '@/lib/utils'
import { agentAccountRouteId, type AccountUsageEntry } from '@open-mercato/cezar-api-client'
import { useQuery } from '@tanstack/react-query'

/** Needs a QueryClient: callers outside one (the shell's tests) guard at the call site. */
export function AccountUsageWidget({
  runner,
  agentProfile,
  className,
  fraction = 'used',
  compact = false,
}: {
  runner?: string
  agentProfile?: string
  className?: string
  fraction?: LiveUsageFraction
  /** Phone header: a dot and the busiest window's percent; a tap shows the full chip. */
  compact?: boolean
} = {}) {
  const transport = useHostTransport()
  const enabled = useLiveUsageEnabled()
  if (transport !== 'local' || !enabled) return null
  return (
    <AccountUsageWidgetBody
      runner={runner}
      agentProfile={agentProfile}
      className={className}
      fraction={fraction}
      compact={compact}
    />
  )
}

function AccountUsageWidgetBody({
  runner,
  agentProfile,
  className,
  fraction,
  compact,
}: {
  runner?: string
  agentProfile?: string
  className?: string
  fraction: LiveUsageFraction
  compact: boolean
}) {
  const usage = useAccountUsage()
  const profiles = useAgentProfiles()
  const rows = useMemo(
    () => sortAccountUsageEntries(usage.data?.accounts ?? []),
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
  if (compact && visible[0]) return <CompactUsage entry={visible[0]} fraction={fraction} className={className} />
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

const DOT_CLASS: Record<LiveUsageTone, string> = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

function CompactUsage({ entry, fraction, className }: { entry: AccountUsageEntry; fraction: LiveUsageFraction; className?: string }) {
  const peak = peakUsage(entry.usage)
  if (!peak) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="account-usage-compact"
          data-tone={peak.tone}
          aria-label={`Plan usage: ${peak.label} at ${peak.percent}%. Show details`}
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-meta tabular-nums text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            className,
          )}
        >
          <span aria-hidden="true" className={cn('size-2 rounded-full', DOT_CLASS[peak.tone])} />
          {peak.percent}%
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={8} className="w-auto max-w-[calc(100vw-1rem)] p-2">
        <AccountUsageChip entry={entry} fraction={fraction} />
      </PopoverContent>
    </Popover>
  )
}

function AccountUsageChip({
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

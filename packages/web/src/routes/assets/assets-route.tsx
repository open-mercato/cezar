import { LayersIcon, TriangleAlertIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useProjectAssets, useRuns } from '@/api/queries'
import type { ProjectAsset, RunStatus } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Segmented } from '@/components/segmented'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { ASSET_FILTERS, assetState, filterAssets, subjectLink, taskAssetPath, type AssetFilter, type AssetState } from './assets-model'

/**
 * `/assets` — every artifact across the project's runs (spec 2026-10-22-html-artifacts-and-impact,
 * Phase 3). No preview here: a row opens its task's Assets view. Kept live by the `artifacts`
 * SSE frame (global-events.tsx); a row's run status reads from the stream-patched runs list.
 */
export function AssetsRoute() {
  const assets = useProjectAssets()
  const runs = useRuns()
  const [filter, setFilter] = useState<AssetFilter>('all')
  const liveStatus = useMemo(() => new Map((runs.data ?? []).map((run) => [run.id, run.status])), [runs.data])
  const rows = useMemo(() => filterAssets(assets.data?.assets ?? [], filter), [assets.data, filter])
  const statusOf = (row: ProjectAsset): RunStatus => liveStatus.get(row.runId) ?? row.runStatus
  const total = assets.data?.assets.length ?? 0

  return (
    <div data-route="assets" className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Assets". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Assets</h1>
        <p className="text-ui text-muted-foreground">Every page and report your agents wrote, newest first.</p>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {assets.isPending ? (
          <p data-slot="assets-loading" className="py-6 text-center text-label text-muted-foreground">Loading assets…</p>
        ) : assets.isError ? (
          // The one error template: a cause line and one action.
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="danger"
            heading="h2"
            title="Could not load assets"
            subtitle={assets.error instanceof Error ? assets.error.message : String(assets.error)}
            actions={
              <Button type="button" variant="outline" data-action="assets-retry" onClick={() => void assets.refetch()}>
                Try again
              </Button>
            }
          />
        ) : total === 0 ? (
          <CenteredState
            icon={<LayersIcon />}
            title="No assets yet"
            subtitle="When an agent writes a page or report into its artifacts folder, it shows up here and in its task's Assets tab."
          />
        ) : (
          <>
            {/* Two to five options: the shared segmented control. */}
            <Segmented<AssetFilter>
              slot="assets-filter"
              label="Filter assets"
              value={filter}
              options={ASSET_FILTERS.map(({ id, label }) => ({ value: id, label }))}
              onChange={setFilter}
            />

            {rows.length === 0 ? (
              <p data-slot="assets-filter-empty" className="py-6 text-center text-label text-muted-foreground">
                No {ASSET_FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} assets.
              </p>
            ) : (
              <>
                <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
                  <table data-slot="assets-table" className="w-full border-collapse text-ui">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th scope="col" className="px-3 py-2 eyebrow text-soft-foreground">Asset</th>
                        <th scope="col" className="px-3 py-2 eyebrow text-soft-foreground">Subject</th>
                        <th scope="col" className="px-3 py-2 eyebrow text-soft-foreground">State</th>
                        <th scope="col" className="px-3 py-2 eyebrow text-soft-foreground">Version</th>
                        <th scope="col" className="px-3 py-2 eyebrow text-soft-foreground">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={`${row.runId}/${row.name}`} data-slot="asset-row" className="border-b border-border last:border-b-0 hover:bg-muted/50">
                          <td className="max-w-0 px-3 py-2"><AssetCell row={row} /></td>
                          <td className="px-3 py-2"><SubjectCell row={row} /></td>
                          <td className="px-3 py-2"><StateChip state={assetState(row, statusOf(row))} /></td>
                          {/* A version count is a count, not code — no mono. */}
                          <td className="px-3 py-2 text-label tabular-nums">v{row.versionCount}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-label text-muted-foreground"><Age iso={row.updatedAt} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Below `md` the table stacks into cards. */}
                <ul data-slot="assets-cards" className="flex flex-col gap-2 md:hidden">
                  {rows.map((row) => (
                    <li key={`${row.runId}/${row.name}`} data-slot="asset-card" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-ui">
                      <AssetCell row={row} />
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
                        <SubjectCell row={row} />
                        <StateChip state={assetState(row, statusOf(row))} />
                        <span className="tabular-nums">v{row.versionCount}</span>
                        <Age iso={row.updatedAt} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {assets.data?.truncated ? (
              <p data-slot="assets-truncated" className="text-label text-muted-foreground">Showing the newest {total} assets.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function AssetCell({ row }: { row: ProjectAsset }) {
  const to = taskAssetPath(row)
  return (
    <div className="flex min-w-0 flex-col">
      <Link data-slot="asset-link" to={to} className="truncate font-semibold text-foreground hover:underline focus-visible:underline focus-visible:outline-none">
        {row.title ?? row.name}
      </Link>
      <span className="truncate text-label text-muted-foreground">
        <span className="font-mono">{row.name}</span>
        {' · '}
        <Link data-slot="asset-task-link" to={to} className="hover:text-foreground hover:underline">
          {row.runTitle}
        </Link>
      </span>
    </div>
  )
}

function SubjectCell({ row }: { row: ProjectAsset }) {
  if (!row.subject) return <span className="text-muted-foreground">—</span>
  const link = subjectLink(row.subject)
  return (
    <IconTooltip label={link.title}>
      <Link data-slot="asset-subject" to={link.to} className="whitespace-nowrap text-foreground hover:underline">
        {link.label}
      </Link>
    </IconTooltip>
  )
}

/**
 * The status grammar on an asset (redesign 2026-11): the hue lives in the `StatusDot`, the word
 * stays ink. Running = violet pulse (cezar working), stale = amber (parked, wants a refresh),
 * current = green (done). `none` is a plain dash — nothing to colour.
 */
const STATE_STYLE: Record<AssetState, { label: string; dot: StatusDotTone | null; pulse: boolean }> = {
  running: { label: 'running', dot: 'violet', pulse: true },
  stale: { label: 'stale', dot: 'pending', pulse: false },
  current: { label: 'current', dot: 'success', pulse: false },
  none: { label: '—', dot: null, pulse: false },
}

function StateChip({ state }: { state: AssetState }) {
  const { label, dot, pulse } = STATE_STYLE[state]
  const chip = (
    <span
      data-slot="asset-state"
      data-state={state}
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border px-2 text-label font-medium whitespace-nowrap',
        dot ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {dot ? <StatusDot tone={dot} pulse={pulse} /> : null}
      {label}
    </span>
  )
  return state === 'none' ? <IconTooltip label="No subject, or its state cannot be told">{chip}</IconTooltip> : chip
}

function Age({ iso }: { iso: string }) {
  const age = shortAge(iso)
  return (
    <IconTooltip label={new Date(iso).toLocaleString()}>
      <time dateTime={iso}>{age ? `${age} ago` : ''}</time>
    </IconTooltip>
  )
}

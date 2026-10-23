import { LayersIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useProjectAssets, useRuns } from '@/api/queries'
import type { ProjectAsset, RunStatus } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
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
        <p className="text-[13px] text-soft-foreground">Every page and report your agents wrote, newest first.</p>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {assets.isPending ? (
          <p data-slot="assets-loading" className="py-6 text-center text-xs text-soft-foreground">Loading assets…</p>
        ) : assets.isError ? (
          <p role="alert" className="py-6 text-center text-xs text-destructive">
            Could not load assets: {assets.error instanceof Error ? assets.error.message : String(assets.error)}
          </p>
        ) : total === 0 ? (
          <CenteredState
            icon={<LayersIcon />}
            title="No assets yet"
            subtitle="When an agent writes a page or report into its artifacts folder, it shows up here and in its task's Assets tab."
          />
        ) : (
          <>
            <div role="group" aria-label="Filter assets" className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
              {ASSET_FILTERS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  data-slot="assets-filter"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={cn(
                    'h-7 rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                    filter === id && 'bg-card font-semibold text-foreground shadow-xs',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {rows.length === 0 ? (
              <p data-slot="assets-filter-empty" className="py-6 text-center text-xs text-soft-foreground">
                No {ASSET_FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} assets.
              </p>
            ) : (
              <>
                <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
                  <table data-slot="assets-table" className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[11.5px] font-medium text-muted-foreground">
                        <th scope="col" className="px-3 py-2 font-medium">Asset</th>
                        <th scope="col" className="px-3 py-2 font-medium">Subject</th>
                        <th scope="col" className="px-3 py-2 font-medium">State</th>
                        <th scope="col" className="px-3 py-2 font-medium">Version</th>
                        <th scope="col" className="px-3 py-2 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={`${row.runId}/${row.name}`} data-slot="asset-row" className="border-b border-border last:border-b-0 hover:bg-muted/50">
                          <td className="max-w-0 px-3 py-2"><AssetCell row={row} /></td>
                          <td className="px-3 py-2"><SubjectCell row={row} /></td>
                          <td className="px-3 py-2"><StateChip state={assetState(row, statusOf(row))} /></td>
                          <td className="px-3 py-2 font-mono text-xs tabular-nums">v{row.versionCount}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground"><Age iso={row.updatedAt} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Below `md` the table stacks into cards. */}
                <ul data-slot="assets-cards" className="flex flex-col gap-2 md:hidden">
                  {rows.map((row) => (
                    <li key={`${row.runId}/${row.name}`} data-slot="asset-card" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-[13px]">
                      <AssetCell row={row} />
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <SubjectCell row={row} />
                        <StateChip state={assetState(row, statusOf(row))} />
                        <span className="font-mono tabular-nums">v{row.versionCount}</span>
                        <Age iso={row.updatedAt} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {assets.data?.truncated ? (
              <p data-slot="assets-truncated" className="text-xs text-soft-foreground">Showing the newest {total} assets.</p>
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
      <span className="truncate text-xs text-muted-foreground">
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
    <Link data-slot="asset-subject" to={link.to} title={link.title} className="whitespace-nowrap text-foreground hover:underline">
      {link.label}
    </Link>
  )
}

/** Hue on the dot only; the words stay ink so both themes read (status fills are not text colours). */
const STATE_STYLE: Record<AssetState, { label: string; dot: string | null; className: string }> = {
  running: { label: 'running', dot: 'bg-pending animate-pulse', className: 'text-foreground' },
  stale: { label: 'stale', dot: 'bg-pending', className: 'border-pending/50 text-pending-strong' },
  current: { label: 'current', dot: 'bg-success', className: 'text-foreground' },
  none: { label: '—', dot: null, className: 'text-muted-foreground' },
}

function StateChip({ state }: { state: AssetState }) {
  const { label, dot, className } = STATE_STYLE[state]
  return (
    <span
      data-slot="asset-state"
      data-state={state}
      title={state === 'none' ? 'No subject, or its state cannot be told' : undefined}
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', className)}
    >
      {dot ? <span aria-hidden="true" className={cn('size-1.5 rounded-full', dot)} /> : null}
      {label}
    </span>
  )
}

function Age({ iso }: { iso: string }) {
  const age = shortAge(iso)
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{age ? `${age} ago` : ''}</time>
}

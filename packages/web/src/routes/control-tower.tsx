/**
 * Control Tower — workspace-wide swarm telemetry + governor.
 * Spec: `.ai/specs/2026-09-19-autopilot-heal-tower.md`
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActivityIcon, PauseIcon, RadarIcon, RefreshCwIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { AutopilotGovernor, TowerSnapshot } from '@open-mercato/cezar-api-client'

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

function nullableNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

export function ControlTowerRoute() {
  const health = useHealth()
  const off = health.data?.capabilities?.autopilot === false
  const queryClient = useQueryClient()
  const [extraParallel, setExtraParallel] = useState(4)
  const [draft, setDraft] = useState<AutopilotGovernor | null>(null)

  const tower = useQuery({
    queryKey: ['autopilot', 'tower', extraParallel],
    enabled: !off,
    refetchInterval: 3_000,
    queryFn: async () => {
      const res = await fetch('/api/v1/workspace/autopilot/tower')
      return readJson<TowerSnapshot>(res)
    },
  })

  const governorQuery = useQuery({
    queryKey: ['autopilot', 'governor'],
    enabled: !off,
    queryFn: async () => {
      const res = await fetch('/api/v1/workspace/autopilot/governor')
      return readJson<AutopilotGovernor>(res)
    },
  })

  const governor = draft ?? governorQuery.data ?? null

  const saveGovernor = useMutation({
    mutationFn: async (next: AutopilotGovernor) => {
      const res = await fetch('/api/v1/workspace/autopilot/governor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      return readJson<AutopilotGovernor>(res)
    },
    onSuccess: (written) => {
      setDraft(null)
      queryClient.setQueryData(['autopilot', 'governor'], written)
      void queryClient.invalidateQueries({ queryKey: ['autopilot', 'tower'] })
    },
  })

  const evaluate = useMutation({
    mutationFn: async (apply: boolean) => {
      const res = await fetch('/api/v1/workspace/autopilot/tower', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply, extraParallel }),
      })
      return readJson<TowerSnapshot>(res)
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(['autopilot', 'tower', extraParallel], snapshot)
    },
  })

  const rows = tower.data?.runs ?? []
  const liveHeat = useMemo(() => {
    const maxRss = Math.max(1, ...rows.map((r) => r.usage?.rssBytes ?? 0))
    return rows.map((r) => ({
      ...r,
      heat: (r.usage?.rssBytes ?? 0) / maxRss,
    }))
  }, [rows])

  if (off) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-sm text-muted-foreground">
        Autopilot is off (<code className="text-foreground">CEZ_AUTOPILOT=0</code>). Restart without
        that flag to open Control Tower.
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6" data-slot="control-tower">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <RadarIcon className="size-5" aria-hidden />
            Control Tower
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live swarm telemetry across every project. Governor caps default to off — set one, then
            Apply to pause offenders. Self-Heal still never merges.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void tower.refetch()}
            disabled={tower.isFetching}
          >
            <RefreshCwIcon className={cn('size-3.5', tower.isFetching && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => evaluate.mutate(false)}
            disabled={evaluate.isPending}
          >
            Preview
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => evaluate.mutate(true)}
            disabled={evaluate.isPending}
          >
            <PauseIcon className="size-3.5" />
            Apply governor
          </Button>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Running" value={String(tower.data?.running ?? '—')} />
        <Stat label="Queued" value={String(tower.data?.queued ?? '—')} />
        <Stat
          label="$ / hour"
          value={tower.data ? `$${tower.data.spendUsdPerHour.toFixed(2)}` : '—'}
        />
        <Stat
          label="RSS total"
          value={tower.data ? `${Math.round(tower.data.totalRssMb)} MiB` : '—'}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">Governor</h2>
          {!governor ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Max $ / hour"
                value={governor.maxSpendUsdPerHour ?? ''}
                onChange={(v) =>
                  setDraft({ ...governor, maxSpendUsdPerHour: nullableNumber(String(v)) })
                }
                placeholder="no cap"
              />
              <Field
                label="Max RSS MiB (sum)"
                value={governor.maxRssMbTotal ?? ''}
                onChange={(v) =>
                  setDraft({ ...governor, maxRssMbTotal: nullableNumber(String(v)) })
                }
                placeholder="no cap"
              />
              <Field
                label="Stuck after (min)"
                value={governor.stuckAfterMinutes ?? ''}
                onChange={(v) =>
                  setDraft({ ...governor, stuckAfterMinutes: nullableNumber(String(v)) })
                }
                placeholder="no stuck check"
              />
              <Field
                label="Soft maxParallel"
                value={governor.softMaxParallel ?? ''}
                onChange={(v) =>
                  setDraft({ ...governor, softMaxParallel: nullableNumber(String(v)) })
                }
                placeholder="no soft-cap"
              />
              <div className="sm:col-span-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!draft || saveGovernor.isPending}
                  onClick={() => draft && saveGovernor.mutate(draft)}
                >
                  Save caps
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">What-if</h2>
          <div className="flex items-end gap-3">
            <div className="grow space-y-1.5">
              <Label htmlFor="extra-parallel">Extra parallel agents</Label>
              <Input
                id="extra-parallel"
                type="number"
                min={0}
                max={16}
                value={extraParallel}
                onChange={(e) => setExtraParallel(Number(e.target.value) || 0)}
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => evaluate.mutate(false)}>
              Recalc
            </Button>
          </div>
          {tower.data?.forecast ? (
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              <li>
                Projected $/h:{' '}
                <span className="text-foreground">
                  {tower.data.forecast.projectedUsdPerHour != null
                    ? `$${tower.data.forecast.projectedUsdPerHour.toFixed(2)}`
                    : '—'}
                </span>
                {tower.data.forecast.wouldExceedSpend ? (
                  <span className="ml-2 text-destructive">over spend cap</span>
                ) : null}
              </li>
              <li>
                Projected RSS:{' '}
                <span className="text-foreground">
                  {tower.data.forecast.projectedRssMb != null
                    ? `${Math.round(tower.data.forecast.projectedRssMb)} MiB`
                    : '—'}
                </span>
                {tower.data.forecast.wouldExceedRss ? (
                  <span className="ml-2 text-destructive">over RSS cap</span>
                ) : null}
              </li>
              <li>
                Parallel:{' '}
                <span className="text-foreground">
                  {tower.data.effectiveMaxParallel}/{tower.data.maxParallel}
                </span>
              </li>
            </ul>
          ) : null}
        </div>
      </section>

      {(tower.data?.actions.length ?? 0) > 0 ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-medium">Governor actions</h2>
          <ul className="space-y-1 text-sm">
            {tower.data!.actions.map((a, i) => (
              <li key={`${a.kind}-${a.runId ?? i}`} className="flex gap-2">
                <span className="font-mono text-xs uppercase text-muted-foreground">{a.kind}</span>
                <span>{a.reason}</span>
                {a.applied ? (
                  <span className="text-foreground">applied</span>
                ) : (
                  <span className="text-muted-foreground">preview</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ActivityIcon className="size-4" aria-hidden />
          <h2 className="text-sm font-medium">Live agents</h2>
        </div>
        {liveHeat.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No running or queued tasks right now.</p>
        ) : (
          <ul className="divide-y divide-border">
            {liveHeat.map((run) => (
              <li key={`${run.projectId}:${run.runId}`} className="relative px-4 py-3">
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 bg-primary/10"
                  style={{ width: `${Math.round(run.heat * 100)}%` }}
                  aria-hidden
                />
                <div className="relative flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="font-medium">{run.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {run.projectName} · {run.status} · {Math.round(run.ageMinutes)}m
                      {run.stuck ? ' · stuck' : ''}
                    </div>
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'} ·{' '}
                    {run.usage
                      ? `${Math.round(run.usage.rssBytes / (1024 * 1024))} MiB · ${Math.round(run.usage.cpuPct)}% cpu`
                      : 'no sample'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string | number
  onChange: (v: string | number) => void
  placeholder: string
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </div>
  )
}

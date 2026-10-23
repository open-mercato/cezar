import type { UseMutationResult } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Settings → Resources → "Keep this computer responsive" (spec 2026-10-21-host-resource-limits).
 * The preset is a shortcut over the individual fields below it; it writes the same keys.
 */

type Priority = 'normal' | 'low' | 'idle'
type Save = UseMutationResult<WorkspaceConfigResponse, Error, SetWorkspaceConfigInput>

/** Low priority plus enough headroom that a browser and an editor stay usable. */
export const RESPONSIVE_PRESET = {
  agentCpuPriority: 'low' as Priority,
  hostReserve: { memoryMb: 2048, cpuPct: 90 },
}

/** Below this a guard would never admit real work. */
const MIN_RESERVE_MB = 256
const FIELD =
  'block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'

const text = (n: number | null | undefined) => (n ? String(n) : '')

/** '' = off (null); otherwise a whole number inside [min, max], else undefined (invalid). */
function parseLimit(raw: string, min: number, max: number): number | null | undefined {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

export function HostLimitsFields({ config, save }: { config: WorkspaceConfigResponse; save: Save }) {
  const r = config.resources
  const priority = r.agentCpuPriority ?? 'normal'
  const reserve = r.hostReserve ?? { memoryMb: null, cpuPct: null }
  const [reserveMem, setReserveMem] = useState(text(reserve.memoryMb))
  const [reserveCpu, setReserveCpu] = useState(text(reserve.cpuPct))
  const [totalMem, setTotalMem] = useState(text(r.totalAgentMemoryMb))

  const mem = parseLimit(reserveMem, MIN_RESERVE_MB, 1_048_576)
  const cpu = parseLimit(reserveCpu, 1, 100)
  const total = parseLimit(totalMem, MIN_RESERVE_MB, 1_048_576)
  const invalid = mem === undefined || cpu === undefined || total === undefined
  const saved =
    !invalid &&
    mem === (reserve.memoryMb || null) &&
    cpu === (reserve.cpuPct || null) &&
    total === (r.totalAgentMemoryMb || null)
  const responsive = priority !== 'normal' && (reserve.memoryMb ?? 0) > 0 && (reserve.cpuPct ?? 0) > 0

  // An edit made elsewhere (another tab, a PUT) replaces the local drafts.
  useEffect(() => setReserveMem(text(reserve.memoryMb)), [reserve.memoryMb])
  useEffect(() => setReserveCpu(text(reserve.cpuPct)), [reserve.cpuPct])
  useEffect(() => setTotalMem(text(r.totalAgentMemoryMb)), [r.totalAgentMemoryMb])

  const applyPreset = (on: boolean) => {
    // On only fills what is empty: a custom reserve or priority the user already chose stays.
    const memoryMb = reserve.memoryMb || RESPONSIVE_PRESET.hostReserve.memoryMb
    const cpuPct = reserve.cpuPct || RESPONSIVE_PRESET.hostReserve.cpuPct
    const patch: SetWorkspaceConfigInput = on
      ? {
          resources: {
            agentCpuPriority: priority === 'normal' ? RESPONSIVE_PRESET.agentCpuPriority : priority,
            hostReserve: { memoryMb, cpuPct },
          },
        }
      : { resources: { agentCpuPriority: 'normal', hostReserve: { memoryMb: null, cpuPct: null } } }
    save.mutate(patch, {
      onSuccess: () => {
        toast(on ? 'Agents now run at low priority and leave headroom' : 'Agents run at normal priority')
      },
    })
  }

  return (
    <>
      <SettingsField
        title="Keep this computer responsive"
        hint="Runs agents at low CPU priority and holds back new tasks while the machine is short on memory or busy. Running tasks are never interrupted; queued ones start when pressure eases."
      >
        <select
          aria-label="Keep this computer responsive"
          data-slot="resources-responsive-preset"
          value={responsive ? 'on' : 'off'}
          disabled={save.isPending}
          onChange={(event) => applyPreset(event.target.value === 'on')}
          className={FIELD}
        >
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>
        <p className="text-[11px] text-soft-foreground">
          On = low priority, keep {RESPONSIVE_PRESET.hostReserve.memoryMb} MiB free, pause starts above{' '}
          {RESPONSIVE_PRESET.hostReserve.cpuPct}% CPU. Fine-tune below.
        </p>
      </SettingsField>

      <SettingsField
        title="Agent CPU priority"
        hint="Operating-system priority of every agent and the tools it runs. Lower priority lets your own apps win when the CPU is contended."
      >
        <select
          aria-label="Agent CPU priority"
          data-slot="resources-cpu-priority"
          value={priority}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ resources: { agentCpuPriority: event.target.value as Priority } })}
          className="block w-44 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <option value="normal">Normal</option>
          <option value="low">Low (below normal)</option>
          <option value="idle">Idle (only spare CPU)</option>
        </select>
        <p className="text-[11px] text-soft-foreground">
          Best effort, for newly started agent steps: a process the OS refuses to renice keeps normal priority.
        </p>
      </SettingsField>

      <SettingsField
        title="Host headroom"
        hint="New tasks wait while the machine is below the free-memory floor, above the CPU ceiling, or the agents together hold too much RAM. Empty = off. One task always runs, so the queue never stalls."
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-xs text-soft-foreground">
            Keep free
            <input
              type="number"
              inputMode="numeric"
              min={MIN_RESERVE_MB}
              step={256}
              aria-label="Keep free memory in MiB"
              data-slot="resources-reserve-memory"
              value={reserveMem}
              placeholder="off"
              disabled={save.isPending}
              onChange={(event) => setReserveMem(event.target.value)}
              className={FIELD}
            />
            MiB
          </label>
          <label className="flex items-center gap-2 text-xs text-soft-foreground">
            Pause above
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              aria-label="Pause new tasks above host CPU percent"
              data-slot="resources-reserve-cpu"
              value={reserveCpu}
              placeholder="off"
              disabled={save.isPending}
              onChange={(event) => setReserveCpu(event.target.value)}
              className={FIELD}
            />
            % CPU
          </label>
          <label className="flex items-center gap-2 text-xs text-soft-foreground">
            All agents max
            <input
              type="number"
              inputMode="numeric"
              min={MIN_RESERVE_MB}
              step={256}
              aria-label="Total agent memory limit in MiB"
              data-slot="resources-total-agent-memory"
              value={totalMem}
              placeholder="off"
              disabled={save.isPending}
              onChange={(event) => setTotalMem(event.target.value)}
              className={FIELD}
            />
            MiB
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-host-headroom"
            disabled={saved || invalid || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  resources: {
                    hostReserve: { memoryMb: mem ?? null, cpuPct: cpu ?? null },
                    totalAgentMemoryMb: total ?? null,
                  },
                },
                { onSuccess: () => toast('Host headroom saved') },
              )
            }
          >
            Save
          </Button>
        </div>
        {invalid ? (
          <p data-slot="resources-host-invalid" className="text-[11px] text-danger">
            Memory needs a whole number of at least {MIN_RESERVE_MB} MiB, CPU 1 to 100 — or leave empty.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            Uses the container limit when cezar runs in one. Missing telemetry never blocks a start.
          </p>
        )}
      </SettingsField>
    </>
  )
}

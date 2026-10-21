import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import { MAX_CONCURRENCY, type SetWorkspaceConfigInput, type WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { IntegerStepper } from '@/components/integer-stepper'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Settings → Resources → separate pools for dispatched sub-agents and reviews, and automatic
 * scaling to free resources (spec 2026-10-21-work-limits). Rendered right under "Max parallel
 * tasks", which it qualifies.
 */

const POLL_MS = 5_000

/** "3 of 8" when autoScale has lowered a pool, otherwise just the configured number. */
export function effectiveText(effective: number | null | undefined, configured: number): string {
  return effective !== null && effective !== undefined && effective < configured
    ? `effective ${effective} of ${configured}`
    : `${configured}`
}

export function WorkLimitsFields({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const r = config.resources
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const autoScale = r.autoScale ?? false
  const effective = r.effective

  // Effective limits move with the machine, so follow them while autoScale is on.
  useEffect(() => {
    if (!autoScale) return
    const timer = setInterval(() => void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.config }), POLL_MS)
    return () => clearInterval(timer)
  }, [autoScale, queryClient])

  const pool = (
    key: 'maxSubagents' | 'maxReviewers',
    label: string,
    hint: string,
    slot: string,
    effectiveValue: number | null | undefined,
  ) => (
    <SettingsField title={label} hint={hint}>
      <IntegerStepper
        aria-label={label}
        data-slot={slot}
        value={r[key] ?? null}
        min={1}
        max={MAX_CONCURRENCY}
        allowEmpty
        emptyStepFrom={Math.min(MAX_CONCURRENCY, Math.max(1, r.maxParallel))}
        placeholder={`Shared (${r.maxParallel})`}
        className="w-40"
        onCommit={(next) => save.mutateAsync({ resources: { [key]: next } })}
      />
      <p className="text-[11px] text-soft-foreground">
        {r[key] == null
          ? 'Empty: these tasks share Max parallel tasks.'
          : `Own pool, not counted against Max parallel tasks: ${effectiveText(effectiveValue, r[key])}.`}
      </p>
    </SettingsField>
  )

  return (
    <>
      {pool(
        'maxSubagents',
        'Max sub-agents',
        'Tasks that another task dispatched (implement) get their own pool, so parents holding every parallel slot cannot starve their own children.',
        'resources-max-subagents',
        effective?.maxSubagents,
      )}
      {pool(
        'maxReviewers',
        'Max reviewers',
        'Dispatched review tasks get their own pool, so intake cannot stall waiting for reviews that wait for a slot.',
        'resources-max-reviewers',
        effective?.maxReviewers,
      )}
      <SettingsField
        title="Scale limits to free resources"
        hint="Lowers every limit above to what free memory and CPU can carry, measured from the agents already running. Never raises a limit, never stops a running task, never goes below one."
      >
        <select
          aria-label="Scale limits to free resources"
          data-slot="resources-auto-scale"
          value={autoScale ? 'on' : 'off'}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ resources: { autoScale: event.target.value === 'on' } })}
          className="block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>
        <p data-slot="resources-effective" className="text-[11px] text-soft-foreground">
          {autoScale
            ? `Right now: tasks ${effectiveText(effective?.maxParallel, r.maxParallel)}${
                r.maxSubagents ? `, sub-agents ${effectiveText(effective?.maxSubagents, r.maxSubagents)}` : ''
              }${r.maxReviewers ? `, reviewers ${effectiveText(effective?.maxReviewers, r.maxReviewers)}` : ''}.`
            : 'Off: the limits above apply as configured.'}
        </p>
      </SettingsField>
    </>
  )
}

import type { Runner } from '@open-mercato/cezar-api-client'

import { runnerSupportsServiceTier } from '@open-mercato/cezar-api-client'

import { PickerPill } from '@/components/picker-pill'

export interface ServiceTierOption {
  id: string
  name: string
  description?: string
}

/** Rendered only for a Codex model whose catalog ADVERTISES tiers; older CLIs show nothing (#1946). */
export function serviceTierOffered(runner: Runner, model: string, options: readonly ServiceTierOption[]): boolean {
  return runnerSupportsServiceTier(runner) && model !== '' && options.length > 0
}

/**
 * Codex speed (Fast / Ultrafast…): ids and names come from the model's own `serviceTiers`, never a
 * hard-coded list. The empty value is Codex's native default and puts nothing on the wire.
 */
export function ServiceTierPill({
  runner,
  model,
  value,
  options,
  onPick,
  disabled = false,
  modelsLocked = false,
  bare = false,
  className,
}: {
  runner: Runner
  model: string
  value: string
  options: readonly ServiceTierOption[]
  onPick: (value: string) => void
  disabled?: boolean
  modelsLocked?: boolean
  bare?: boolean
  className?: string
}) {
  if (!serviceTierOffered(runner, model, options)) return null

  const shownValue = modelsLocked ? '' : value
  const selected = options.find((option) => option.id === shownValue)
  const label = shownValue === ''
    ? (bare ? 'default' : 'Speed: default')
    : (selected?.name ?? shownValue)
  const hint = 'Codex speed for this task. Faster tiers can use your plan’s limits more quickly.'

  return (
    <PickerPill
      slot="service-tier-pill"
      ariaLabel="Speed"
      label={label}
      value={shownValue}
      disabled={disabled}
      readOnly={modelsLocked}
      className={className}
      hint={hint}
      disabledHint={modelsLocked ? 'Speed is locked to native Codex settings.' : hint}
      onPick={onPick}
      options={[
        { value: '', label: 'Codex default', desc: 'Use Codex’s native speed setting' },
        ...options.map((option) => ({ value: option.id, label: option.name, desc: option.description })),
      ]}
    />
  )
}

import type { Runner } from '@open-mercato/cezar-api-client'

import { runnerSupportsReasoningEffort } from '@open-mercato/cezar-api-client'

import { PickerPill } from '@/components/picker-pill'
import { discoveryRunnerLabel } from '@/routes/new-task-form'

export interface ReasoningEffortOption {
  id: string
  description?: string
}

/**
 * A deliberately narrow control: effort belongs only to a discovered, concrete
 * model of an effort-capable runner (Codex, Claude — #808). Reusing it across every
 * launch surface keeps "<runner> default" truly implicit instead of each form
 * inventing a different wire convention.
 */
export function ReasoningEffortPill({
  runner,
  model,
  value,
  options,
  onPick,
  disabled = false,
  modelsLocked = false,
}: {
  runner: Runner
  model: string
  value: string
  options: readonly ReasoningEffortOption[]
  onPick: (value: string) => void
  disabled?: boolean
  modelsLocked?: boolean
}) {
  if (!runnerSupportsReasoningEffort(runner) || model === '' || options.length === 0) return null
  const name = discoveryRunnerLabel(runner)

  // A native-settings lock means Cezar must not claim the stale draft value is
  // in force. There is no effort override on the request in this state.
  const shownValue = modelsLocked ? '' : value
  const selected = options.find((option) => option.id === shownValue)
  const label = shownValue === '' ? `Effort: ${name} default` : `Effort: ${selected?.id ?? shownValue}`

  return (
    <PickerPill
      slot="effort-pill"
      ariaLabel="Effort"
      label={label}
      value={shownValue}
      disabled={disabled}
      readOnly={modelsLocked}
      disabledHint={
        modelsLocked
          ? `Reasoning effort is locked to native ${name} settings.`
          : `How much reasoning the selected ${name} model uses for this task.`
      }
      onPick={onPick}
      options={[
        {
          value: '',
          label: `${name} default`,
          desc: 'Use the selected model’s native reasoning setting',
        },
        ...options.map((option) => ({
          value: option.id,
          label: option.id,
          desc: option.description,
        })),
      ]}
    />
  )
}

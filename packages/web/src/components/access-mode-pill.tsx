import type { Runner, RunnerModelCatalogResponse } from '@open-mercato/cezar-api-client'
import { PickerPill } from './picker-pill'
import { accessModeError, availableAccessModes, modelForAccessMode, type AccessModePick } from '@/lib/access-mode'

const labels = { standard: 'Standard', 'daybreak-blue': 'Daybreak Blue' } as const

export function AccessModePill({ runner, value, model, catalog, onPick, disabled, locked }: {
  runner: Runner
  value: AccessModePick
  model: string
  catalog?: RunnerModelCatalogResponse
  onPick: (mode: AccessModePick, model: string) => void
  disabled?: boolean
  locked?: boolean
}) {
  if (runner !== 'codex' || locked) return null
  const modes = availableAccessModes(catalog)
  if (!value && modes.length === 0) return null
  const shown = value && !modes.includes(value) ? [...modes, value] : modes
  const error = accessModeError(value, model, catalog)
  return (
    <span className="contents">
      <PickerPill
        slot="access-mode-pill"
        ariaLabel="Access mode"
        label={value ? labels[value] : 'Native default'}
        value={value ?? ''}
        disabled={disabled}
        onPick={(next) => {
          const mode = next === 'standard' || next === 'daybreak-blue' ? next : null
          onPick(mode, modelForAccessMode(model, mode, catalog))
        }}
        options={[
          { value: '', label: 'Native default', desc: 'Let Codex choose its automatic treatment' },
          ...shown.map((mode) => ({ value: mode, label: labels[mode], desc: modes.includes(mode) ? 'Advertised by this Codex catalog' : 'Not advertised by this catalog' })),
        ]}
        status={error}
      />
      {error ? <span role="status" className="text-xs text-destructive">{error}</span> : null}
    </span>
  )
}

import { mascotAsset } from './mascot-assets'
import { useId, useState } from 'react'
import { managerMascotSchema, type ManagerMascot } from '@open-mercato/cezar-api-client'

import { cn } from '@/lib/utils'

const MASCOT_NAMES: Record<ManagerMascot, string> = {
  base: 'Cezar', builder: 'Builder', analyst: 'Analyst', guardian: 'Guardian', dispatcher: 'Dispatcher',
  reviewer: 'Reviewer', automator: 'Automator', planner: 'Planner', scout: 'Scout',
}

function Portrait({ mascot, size }: { mascot: ManagerMascot; size: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span aria-hidden="true" className={cn('flex items-center justify-center rounded-full bg-muted text-xl font-semibold text-muted-foreground', size)}>
      {MASCOT_NAMES[mascot].slice(0, 1)}
    </span>
  ) : (
    <img src={mascotAsset(mascot, 'portrait')} alt="" className={cn('object-contain', size)} onError={() => setFailed(true)} />
  )
}

/** Native radios preserve arrow-key selection and one tab stop for the whole gallery. `compact`
 *  is for a dialog, where the gallery must not push the form's other fields out of reach. */
export function MascotPicker({ value, onChange, compact = false }: { value: ManagerMascot | undefined; onChange: (mascot: ManagerMascot) => void; compact?: boolean }) {
  const name = useId()
  return (
    <fieldset className="min-w-0" data-slot="manager-mascot-picker">
      <legend className="mb-2 text-sm font-medium">Character</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {managerMascotSchema.options.map((mascot) => (
          <label key={mascot} className="relative cursor-pointer">
            <input
              type="radio"
              name={name}
              value={mascot}
              checked={value === mascot}
              onChange={() => onChange(mascot)}
              className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
            />
            <span className={cn(
              'flex flex-col items-center justify-center gap-1 rounded-xl border p-1.5 text-xs transition-colors peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50',
              compact ? 'min-h-16' : 'min-h-20 sm:min-h-24 sm:p-2',
              value === mascot ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}>
              <Portrait mascot={mascot} size={compact ? 'size-10' : 'size-12 sm:size-16'} />
              <span>{MASCOT_NAMES[mascot]}</span>
            </span>
          </label>
        ))}
      </div>
      {compact ? null : <p className="mt-2 text-xs text-muted-foreground">Choose a look. Your instructions define what this manager does.</p>}
    </fieldset>
  )
}

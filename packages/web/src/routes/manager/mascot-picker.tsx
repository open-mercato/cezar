import { mascotAsset } from './mascot-assets'
import { useId, useState } from 'react'
import { managerMascotSchema, type ManagerMascot } from '@open-mercato/cezar-api-client'

import { cn } from '@/lib/utils'

const MASCOT_NAMES: Record<ManagerMascot, string> = {
  base: 'Cezar', builder: 'Builder', analyst: 'Analyst', guardian: 'Guardian', dispatcher: 'Dispatcher',
  reviewer: 'Reviewer', automator: 'Automator', planner: 'Planner', scout: 'Scout',
}

function Portrait({ mascot }: { mascot: ManagerMascot }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span aria-hidden="true" className="flex size-16 items-center justify-center rounded-full bg-muted text-xl font-semibold text-muted-foreground">
      {MASCOT_NAMES[mascot].slice(0, 1)}
    </span>
  ) : (
    <img src={mascotAsset(mascot, 'portrait')} alt="" className="size-16 object-contain" onError={() => setFailed(true)} />
  )
}

/** Native radios preserve arrow-key selection and one tab stop for the whole gallery. */
export function MascotPicker({ value, onChange }: { value: ManagerMascot | undefined; onChange: (mascot: ManagerMascot) => void }) {
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
              'flex min-h-24 flex-col items-center justify-center gap-1 rounded-xl border p-2 text-xs transition-colors peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50',
              value === mascot ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}>
              <Portrait mascot={mascot} />
              <span>{MASCOT_NAMES[mascot]}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Choose a look. Your instructions define what this manager does.</p>
    </fieldset>
  )
}

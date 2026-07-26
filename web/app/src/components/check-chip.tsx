import { CheckIcon, SquareIcon } from 'lucide-react'

import { chipClass } from '@/components/picker-pill'
import { cn } from '@/lib/utils'

export function CheckChip({
  slot,
  label,
  on,
  disabled,
  titleOn,
  titleOff,
  disabledTitle,
  onChange,
}: {
  slot: string
  label: string
  on: boolean
  disabled?: boolean
  titleOn: string
  titleOff: string
  disabledTitle?: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      data-slot={slot}
      onClick={() => onChange(!on)}
      title={disabled ? (disabledTitle ?? titleOn) : on ? titleOn : titleOff}
      className={cn(chipClass, on && !disabled && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      {label}
    </button>
  )
}

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import { cn } from '@/lib/utils'

/**
 * A whole-number input with up/down arrows — the settings control for small integer limits
 * (max parallel tasks, extra monitoring sessions) that used to be a fixed dropdown.
 *
 * The field edits a local draft and only commits a VALID, CHANGED value, so typing "12" never
 * saves "1" on the way:
 * - typed text commits on blur or Enter; Escape reverts to the saved value;
 * - the arrow buttons and ArrowUp/ArrowDown step the draft at once and commit after a short
 *   pause, so a burst of clicks is one save rather than one per click;
 * - a value outside `[min, max]` (or not a whole number) is shown as an inline error and never
 *   committed.
 *
 * `allowEmpty` makes an empty field a real value: it commits `null` (the per-project "inherit"
 * sentinel) and stepping from it starts at `emptyStepFrom`. When `onCommit` returns a promise that
 * rejects, the draft falls back to `value` — the caller is expected to report the error itself.
 */

const STEP_COMMIT_DELAY_MS = 400
/** No save in flight (distinct from `null`, which is a real value when `allowEmpty`). */
const NONE = Symbol('none')

export interface IntegerStepperProps {
  value: number | null
  min: number
  max: number
  onCommit: (next: number | null) => unknown
  allowEmpty?: boolean
  /** Where stepping starts from an empty field (default `min`). */
  emptyStepFrom?: number
  placeholder?: string
  disabled?: boolean
  'aria-label': string
  'data-slot'?: string
  className?: string
}

const format = (value: number | null) => (value === null ? '' : String(value))

export function IntegerStepper({
  value,
  min,
  max,
  onCommit,
  allowEmpty = false,
  emptyStepFrom,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
  'data-slot': dataSlot,
  className,
}: IntegerStepperProps) {
  const errorId = useId()
  const [draft, setDraft] = useState(() => format(value))
  const draftRef = useRef(draft)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A stepped commit fires from a timer, after later renders — read the props it needs live.
  const inFlight = useRef<number | null | typeof NONE>(NONE)
  const latest = useRef({ value, onCommit })
  latest.current = { value, onCommit }

  const updateDraft = (next: string) => {
    draftRef.current = next
    setDraft(next)
  }

  // The saved value moved (our own save landing, or another tab's) — show it, unless a stepped
  // value is still waiting to commit.
  useEffect(() => {
    if (timer.current === null) updateDraft(format(value))
  }, [value])

  // Leaving the page within the step pause still saves what the arrows showed.
  const flush = useRef(() => {})
  useEffect(() => () => {
    if (timer.current !== null) flush.current()
  }, [])

  const parse = (text: string): number | null | 'invalid' => {
    const trimmed = text.trim()
    if (trimmed === '') return allowEmpty ? null : 'invalid'
    if (!/^-?\d+$/.test(trimmed)) return 'invalid'
    const parsed = Number(trimmed)
    return parsed < min || parsed > max ? 'invalid' : parsed
  }

  const parsed = parse(draft)
  const invalid = parsed === 'invalid'

  const commit = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const { value: saved, onCommit: save } = latest.current
    const next = parse(draftRef.current)
    // Enter followed by a blur must not send the same value twice while the first save is still
    // in flight — the duplicate keeps the caller's mutation pending for no reason.
    if (next === 'invalid' || next === saved || (inFlight.current !== NONE && next === inFlight.current)) return
    const result = save(next)
    if (result instanceof Promise) {
      inFlight.current = next
      result
        .catch(() => updateDraft(format(latest.current.value)))
        .finally(() => {
          if (inFlight.current === next) inFlight.current = NONE
        })
    }
  }

  flush.current = commit

  const step = (direction: 1 | -1) => {
    const current = parse(draftRef.current)
    // From an empty field the first step lands ON the starting point rather than past it; from
    // unparseable text it moves off the saved value.
    const next =
      current === null
        ? (emptyStepFrom ?? min)
        : current === 'invalid'
          ? (latest.current.value ?? emptyStepFrom ?? min) + direction
          : current + direction
    updateDraft(String(Math.min(max, Math.max(min, next))))
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(commit, STEP_COMMIT_DELAY_MS)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      step(event.key === 'ArrowUp' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      updateDraft(format(value))
    }
  }

  const numeric = typeof parsed === 'number' ? parsed : null
  const buttonClass =
    'flex h-1/2 w-6 items-center justify-center text-soft-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          'flex w-28 items-stretch overflow-hidden rounded-md border border-input bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          invalid && 'border-danger',
          disabled && 'opacity-50',
          className,
        )}
      >
        <input
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label={ariaLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={numeric ?? undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          data-slot={dataSlot}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => updateDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-soft-foreground"
        />
        <div className="flex flex-col border-l border-input">
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Increase ${ariaLabel}`}
            data-action="stepper-increment"
            disabled={disabled || (numeric !== null && numeric >= max)}
            // Keep focus in the field so the click does not blur-commit the draft first.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(1)}
            className={buttonClass}
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Decrease ${ariaLabel}`}
            data-action="stepper-decrement"
            disabled={disabled || (numeric !== null && numeric <= min)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(-1)}
            className={cn(buttonClass, 'border-t border-input')}
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </div>
      </div>
      {invalid ? (
        <p id={errorId} data-slot="stepper-invalid" className="text-[11px] text-danger">
          Enter a whole number from {min} to {max}
          {allowEmpty ? ', or leave it empty' : ''}.
        </p>
      ) : null}
    </div>
  )
}

import { ChevronDownIcon, SplitIcon } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'

import {
  DISPATCH_MAX_IN_FLIGHT,
  type DispatchIntent,
  type Runner,
} from '@open-mercato/cezar-api-client'
import { chipClass } from '@/components/picker-pill'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsDesktop } from '@/lib/use-desktop'
import { useLongPress } from '@/lib/use-long-press'
import { cn } from '@/lib/utils'
import { RUNNERS, type ModelPreset } from '@/routes/new-task-form'

/**
 * The composer's Dispatch toggle (spec 2026-09-10-dispatch; mockup "option 3"): an icon-only
 * pill in the /new footer row. Tap = on/off; hold (or right-click, or ArrowDown / Shift+Enter)
 * = the settings surface, where the limits the intent carries are set. The label lives in the
 * hover tooltip — the row is already full, and a task that fans out is the exception, not the
 * default, so it earns an icon rather than a word.
 *
 * `value` is the draft's `DispatchIntent | null`: `null` off, `{}` on with the engine's
 * defaults, keys for whatever the user limited. Every change in the settings keeps it ON —
 * setting a limit on something that is off would be a setting with nothing to apply to.
 * Turning it off then on again restores the limits it had (kept here, not in the draft, so an
 * off draft stays an honest `null`).
 *
 * The settings surface is a Popover on md-and-up and a bottom Sheet below it: a phone's thumb
 * cannot land on a popover positioned off a 26px pill. Both render the same `DispatchSettings`
 * form. How it OPENS differs by pointer, not only by width: a mouse has no natural hold, so the
 * desktop control is a split pill — the icon toggles, a chevron segment beside it opens the
 * settings on a plain click (right-click and ArrowDown still work). A phone keeps the single
 * icon with tap and hold. The anchor is a `PopoverAnchor`, never a `PopoverTrigger` — Radix's
 * trigger toggles on pointerdown, which is exactly the event the hold begins on.
 *
 * Renders nothing unless `available` (`capabilities.dispatch` is on, in a git repo).
 */
export function DispatchToggle({
  available,
  value,
  onChange,
  onSettingsOpenChange,
  runners,
  parentRunner,
  modelsFor,
}: {
  available: boolean
  value: DispatchIntent | null
  onChange: (next: DispatchIntent | null) => void
  /** The surface opened/closed — the composer keeps its hint line up while it is open. */
  onSettingsOpenChange?: (open: boolean) => void
  /** The runners this host can run — the same list the composer's runner pill offers. */
  runners: readonly Runner[]
  /** What the parent task runs as: "same as parent" resolves against it for the model list. */
  parentRunner: Runner
  /** The composer's model catalog for a runner (its live catalog for the parent's runner, the
   *  static presets for the others). */
  modelsFor: (runner: Runner) => readonly ModelPreset[]
}) {
  const [open, setOpenState] = useState(false)
  const desktop = useIsDesktop()
  // The limits last seen while on — what a re-enable restores.
  const remembered = useRef<DispatchIntent>({})
  if (value !== null) remembered.current = value

  const setOpen = (next: boolean) => {
    setOpenState(next)
    onSettingsOpenChange?.(next)
  }
  const on = value !== null
  const toggle = () => onChange(on ? null : remembered.current)
  const press = useLongPress({ onLongPress: () => setOpen(true), onClick: toggle })

  if (!available) return null

  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Dispatch"
      data-slot="dispatch-toggle"
      data-state={on ? 'on' : 'off'}
      {...press}
      className={cn(
        desktop
          ? // A segment of the split pill below: the ring belongs to the wrapper.
            'inline-flex h-full w-[26px] items-center justify-center transition-colors hover:bg-muted'
          : cn(chipClass, 'w-[26px] justify-center px-0'),
        on && (desktop ? 'hover:bg-primary/15' : 'border-primary/60 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'),
      )}
    >
      <SplitIcon
        aria-hidden="true"
        className={cn('size-3 shrink-0', on ? 'text-primary' : 'text-soft-foreground')}
      />
    </button>
  )

  const settings = (
    <DispatchSettings
      value={value}
      remembered={remembered.current}
      onChange={onChange}
      runners={runners}
      parentRunner={parentRunner}
      modelsFor={modelsFor}
    />
  )

  const tooltip = (
    <TooltipContent side="top" sideOffset={6} className="max-w-[260px]">
      <div className="font-medium">{on ? 'Dispatch — on' : 'Dispatch — off'}</div>
      <div className="text-contrast-foreground/80">
        {on
          ? 'Splits this task into subtasks it runs as separate tasks'
          : 'Let this task split into subtasks'}
      </div>
      {desktop ? <div className="mt-0.5 text-contrast-foreground/60">▾ limits and subtask defaults</div> : null}
    </TooltipContent>
  )

  const trigger = desktop ? (
    // The split pill: one ring, two segments — the icon (toggle) and the chevron (settings).
    <span
      data-slot="dispatch-control"
      data-state={on ? 'on' : 'off'}
      className={cn(
        'inline-flex h-[26px] items-stretch overflow-hidden rounded-full border border-border bg-card text-muted-foreground transition-colors',
        on && 'border-primary/60 bg-primary/10 text-primary',
      )}
    >
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          {tooltip}
        </Tooltip>
      </TooltipProvider>
      <button
        type="button"
        aria-label="Dispatch settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-slot="dispatch-settings-trigger"
        onClick={() => setOpen(!open)}
        className={cn(
          'inline-flex w-[18px] items-center justify-center border-l border-border transition-colors hover:bg-muted',
          on && 'border-primary/40 hover:bg-primary/15',
        )}
      >
        <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
      </button>
    </span>
  ) : (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        {tooltip}
      </Tooltip>
    </TooltipProvider>
  )

  if (!desktop) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            data-slot="dispatch-settings"
            className="rounded-t-xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            {/* Radix wants a title on every dialog; the form's own header is the visible one. */}
            <SheetTitle className="sr-only">Dispatch</SheetTitle>
            <SheetDescription className="sr-only">
              Split this task into subtasks run as separate tasks
            </SheetDescription>
            {settings}
          </SheetContent>
        </Sheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={8}
        data-slot="dispatch-settings"
        className="w-[340px] max-w-[calc(100vw-2rem)] p-3.5"
      >
        {settings}
      </PopoverContent>
    </Popover>
  )
}

/** The mockup's row: label left, control right. */
function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="shrink-0 text-xs text-foreground">
        {label}
      </label>
      {children}
    </div>
  )
}

const selectClass =
  'h-7 max-w-[180px] rounded-md border border-input bg-card px-2 text-xs shadow-xs outline-none transition-[color,box-shadow] hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

const MAX_SUBTASKS_CHOICES = [2, 3, 4, 5, 8, 10, 15, 20, 30, 50] as const
const BUDGET_MIN_USD = 0.5
const BUDGET_MAX_USD = 10_000

/** `{ ...intent, [key]: undefined }` must not reach the wire — the schema is strict about keys,
 *  and JSON drops undefineds anyway, but the draft store and the tests compare objects. */
function compact(intent: DispatchIntent): DispatchIntent {
  const next: DispatchIntent = {}
  if (intent.maxSubtasks !== undefined) next.maxSubtasks = intent.maxSubtasks
  if (intent.inFlight !== undefined) next.inFlight = intent.inFlight
  if (intent.runner !== undefined) next.runner = intent.runner
  if (intent.model !== undefined) next.model = intent.model
  if (intent.budgetUsd !== undefined) next.budgetUsd = intent.budgetUsd
  return next
}

/**
 * The settings form — the header's switch is the same on/off as the pill, and every field
 * below it edits the intent in place. Each control's empty choice is the engine's default,
 * stored as an ABSENT key rather than a sentinel, so the bare toggle stays `{}`.
 */
function DispatchSettings({
  value,
  remembered,
  onChange,
  runners,
  parentRunner,
  modelsFor,
}: {
  value: DispatchIntent | null
  remembered: DispatchIntent
  onChange: (next: DispatchIntent | null) => void
  runners: readonly Runner[]
  parentRunner: Runner
  modelsFor: (runner: Runner) => readonly ModelPreset[]
}) {
  const id = useId()
  const on = value !== null
  const intent = value ?? remembered
  // Editing any field turns it on: a limit is a statement about a dispatch that will happen.
  const set = (patch: Partial<DispatchIntent>) => onChange(compact({ ...intent, ...patch }))

  const subtaskRunner = intent.runner ?? parentRunner
  const models = modelsFor(subtaskRunner).filter((preset) => preset.id !== '')
  const runnerOptions = RUNNERS.filter((runner) => runners.includes(runner.id))
  const maxChoices: number[] =
    intent.maxSubtasks !== undefined && !MAX_SUBTASKS_CHOICES.some((n) => n === intent.maxSubtasks)
      ? [...MAX_SUBTASKS_CHOICES, intent.maxSubtasks].sort((a, b) => a - b)
      : [...MAX_SUBTASKS_CHOICES]

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
        >
          <SplitIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight text-foreground">Dispatch</div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            Split this task into subtasks run as separate tasks
          </p>
        </div>
        <Switch
          aria-label="Dispatch"
          data-slot="dispatch-settings-switch"
          checked={on}
          onCheckedChange={(next) => onChange(next ? remembered : null)}
        />
      </header>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Row label="Max subtasks" htmlFor={`${id}-max`}>
          <select
            id={`${id}-max`}
            data-slot="dispatch-max-subtasks"
            className={selectClass}
            value={intent.maxSubtasks ?? ''}
            onChange={(event) =>
              set({ maxSubtasks: event.target.value === '' ? undefined : Number(event.target.value) })
            }
          >
            <option value="">unlimited</option>
            {maxChoices.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row label="In flight at once" htmlFor={`${id}-flight`}>
          <select
            id={`${id}-flight`}
            data-slot="dispatch-in-flight"
            className={selectClass}
            value={intent.inFlight ?? DISPATCH_MAX_IN_FLIGHT}
            // The engine's ceiling is the default, so choosing it is choosing nothing.
            onChange={(event) => {
              const n = Number(event.target.value)
              set({ inFlight: n === DISPATCH_MAX_IN_FLIGHT ? undefined : n })
            }}
          >
            {Array.from({ length: DISPATCH_MAX_IN_FLIGHT }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Subtask runner" htmlFor={`${id}-runner`}>
          <select
            id={`${id}-runner`}
            data-slot="dispatch-runner"
            className={selectClass}
            value={intent.runner ?? ''}
            // Presets are per-runner, so a kept model would be one the new runner lacks — the
            // same rule the composer's runner pill applies to its model pill.
            onChange={(event) =>
              set({
                runner: event.target.value === '' ? undefined : (event.target.value as Runner),
                model: undefined,
              })
            }
          >
            <option value="">same as parent</option>
            {runnerOptions.map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Subtask model" htmlFor={`${id}-model`}>
          <select
            id={`${id}-model`}
            data-slot="dispatch-model"
            className={selectClass}
            value={intent.model ?? ''}
            onChange={(event) =>
              set({ model: event.target.value === '' ? undefined : event.target.value })
            }
          >
            <option value="">same as parent</option>
            {models.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            {/* A model pinned under a runner whose catalog no longer lists it stays selectable
                rather than silently showing "same as parent" for a value that is still sent. */}
            {intent.model !== undefined && !models.some((preset) => preset.id === intent.model) ? (
              <option value={intent.model}>{intent.model}</option>
            ) : null}
          </select>
        </Row>
        <Row label="Budget per subtask" htmlFor={`${id}-budget`}>
          <span className="flex items-center gap-1.5">
            <Input
              id={`${id}-budget`}
              data-slot="dispatch-budget"
              type="number"
              inputMode="decimal"
              placeholder="none"
              step={0.5}
              min={BUDGET_MIN_USD}
              max={BUDGET_MAX_USD}
              className="h-7 w-24 px-2 text-xs md:text-xs"
              value={intent.budgetUsd ?? ''}
              onChange={(event) => {
                const raw = event.target.value
                const parsed = Number(raw)
                set({
                  budgetUsd:
                    raw === '' || !Number.isFinite(parsed) || parsed <= 0
                      ? undefined
                      : Math.min(BUDGET_MAX_USD, Math.max(BUDGET_MIN_USD, parsed)),
                })
              }}
            />
            <span className="text-xs text-muted-foreground">USD</span>
          </span>
        </Row>
      </div>

      <p className="text-xs leading-snug text-muted-foreground">
        The engine keeps its own brakes: {DISPATCH_MAX_IN_FLIGHT} in flight and budgets carved out
        of this task&apos;s. These only tell the agent what you want.
      </p>
    </div>
  )
}

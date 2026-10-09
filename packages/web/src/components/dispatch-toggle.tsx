import { SlidersHorizontalIcon, SplitIcon } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'

import {
  DISPATCH_MAX_IN_FLIGHT,
  type DispatchIntent,
  type Runner,
} from '@open-mercato/cezar-api-client'
import { useRunnerModels } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { useIsDesktop } from '@/lib/use-desktop'
import { RUNNERS, modelsForRunner, type ModelPreset } from '@/routes/new-task-form'

/**
 * The composer's Dispatch control (spec 2026-09-10-dispatch), one row of the /new "Options"
 * popover: a switch (on/off) and a "Limits" button that opens the settings surface, where the
 * limits the intent carries are set.
 *
 * `value` is the draft's `DispatchIntent | null`: `null` off, `{}` on with the engine's
 * defaults, keys for whatever the user limited. Every change in the settings keeps it ON —
 * setting a limit on something that is off would be a setting with nothing to apply to.
 * Turning it off then on again restores the limits it had (kept here, not in the draft, so an
 * off draft stays an honest `null`).
 *
 * The settings surface is a Popover on md-and-up and a bottom Sheet below it. Both render the
 * same `DispatchSettings` form. The anchor is a `PopoverAnchor`: the Limits button toggles it.
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
  parentModels,
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
  /** The composer's own model catalog — already fetched for the parent's runner, and carrying
   *  the draft/configured ids the composer keeps representable. Used as-is while the subtasks
   *  inherit the runner. */
  parentModels: readonly ModelPreset[]
}) {
  const [open, setOpenState] = useState(false)
  const desktop = useIsDesktop()
  // The limits last seen while on — what a re-enable restores.
  const remembered = useRef<DispatchIntent>({})
  if (value !== null) remembered.current = value

  // The settings edit this intent whether the toggle is on or off (editing a field turns it on),
  // so the model list is resolved from the same object the form below renders.
  const intent = value ?? remembered.current
  const subtaskRunner = intent.runner ?? parentRunner
  // The catalog belongs to the runner the SUBTASKS will use, not the parent's (#794 — the rule
  // the thread's Continue and the engine pills already follow). Without it a subtask runner that
  // DISCOVERS its models — codex, opencode, cursor, junie — showed its static presets, which are
  // `auto` alone since #784/#794, and the select folds `auto` into its own "same as parent": the
  // picker collapsed to one option for exactly the runners whose models are worth picking.
  // Fetched only when that runner differs from the parent's; `parentModels` already covers the
  // inherited case, so the common path still makes one request for the whole composer.
  const subtaskCatalog = useRunnerModels(subtaskRunner, available && subtaskRunner !== parentRunner)
  const models =
    subtaskRunner === parentRunner
      ? parentModels
      : modelsForRunner(subtaskRunner, subtaskCatalog.data)

  const setOpen = (next: boolean) => {
    setOpenState(next)
    onSettingsOpenChange?.(next)
  }
  const on = value !== null

  if (!available) return null

  const settings = (
    <DispatchSettings
      value={value}
      remembered={remembered.current}
      onChange={onChange}
      runners={runners}
      models={models}
    />
  )

  // One row control: a quiet "Limits" button (the settings surface) beside the on/off switch.
  const trigger = (
    <span data-slot="dispatch-control" data-state={on ? 'on' : 'off'} className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label="Dispatch settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-slot="dispatch-settings-trigger"
        onClick={() => setOpen(!open)}
      >
        <SlidersHorizontalIcon aria-hidden="true" />
        Limits
      </Button>
      <Switch
        aria-label="Dispatch"
        data-slot="dispatch-toggle"
        checked={on}
        onCheckedChange={(next) => onChange(next ? remembered.current : null)}
      />
    </span>
  )

  if (!desktop) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            data-slot="dispatch-settings"
            // This sheet has no SheetHeader, so nothing else clears the sheet's close button and
            // it lands on the settings header's own switch — half-covering it before the button
            // grew to a 44px target, entirely after. Reserve the strip it occupies (`top-4` + 44px).
            className="rounded-t-xl p-4 pt-16 pb-[max(1rem,env(safe-area-inset-bottom))]"
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
        align="end"
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
  models: catalog,
}: {
  value: DispatchIntent | null
  remembered: DispatchIntent
  onChange: (next: DispatchIntent | null) => void
  runners: readonly Runner[]
  /** The model catalog of the runner the SUBTASKS will use — the parent's own while the runner
   *  select sits on "same as parent", that runner's otherwise. Resolved by `DispatchToggle`,
   *  which owns the fetch. */
  models: readonly ModelPreset[]
}) {
  const id = useId()
  const on = value !== null
  const intent = value ?? remembered
  // Editing any field turns it on: a limit is a statement about a dispatch that will happen.
  const set = (patch: Partial<DispatchIntent>) => onChange(compact({ ...intent, ...patch }))

  // `auto` (`id: ''`) is dropped because the select's own empty option already says it.
  const models = catalog.filter((preset) => preset.id !== '')
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
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary-strong"
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

import {
  BookmarkPlusIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  HammerIcon,
  PlusIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
  WaypointsIcon,
  XIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { HarnessEffort, HarnessModelRef, HarnessPreset, HarnessRoles } from '@/api/types'
import { chipClass } from '@/components/picker-pill'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import {
  HARNESS_MODES,
  canSaveHarnessPreset,
  groupHarnessOptions,
  harnessRolesIssue,
  freeTierReviewerWarning,
  rolesEqual,
  visibleHarnessPresets,
  type HarnessMode,
  type HarnessModelOption,
} from './new-task-form'

/**
 * The Multi-model tab's surface (user feedback 2026-07-24): pick MODELS FOR ROLES, not a
 * preset topology. One orchestrator (the main agent — long context recommended, it reads the
 * most), one implementer, and 2–5 unique reviewers spanning at least two model families. The
 * route owns fetching and draft state; this stays presentational.
 */

const refKey = (ref: HarnessModelRef) => `${ref.runner}::${ref.model}`
const fromKey = (key: string): HarnessModelRef => {
  const sep = key.indexOf('::')
  return { runner: key.slice(0, sep) as HarnessModelRef['runner'], model: key.slice(sep + 2) }
}

function optionLabel(options: readonly HarnessModelOption[], ref: HarnessModelRef): string {
  const match = options.find((o) => o.runner === ref.runner && o.model === ref.model)
  return match ? `${match.runner} · ${match.label}` : `${ref.runner} · ${ref.model || 'auto'}`
}

/**
 * The role model picker (user feedback 2026-07-24): the flat list does not scale past a
 * couple of providers, so the menu is GROUPED by provider family and SEARCHABLE — the same
 * cmdk surface the skill picker uses. Items are searchable by family, backend, and model
 * name alike.
 */
export function ModelPickerPill({
  slot,
  ariaLabel,
  value,
  options,
  onPick,
  onAddModels,
}: {
  slot: string
  ariaLabel: string
  value: HarnessModelRef
  options: readonly HarnessModelOption[]
  onPick: (ref: HarnessModelRef) => void
  /** Pinned menu footer (2026-07-24): the always-visible path to more providers/models. */
  onAddModels?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const groups = groupHarnessOptions(options)
  const currentKey = refKey(value)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" data-slot={slot} aria-label={ariaLabel} className={chipClass}>
          <span className="font-mono text-[11.5px]">{optionLabel(options, value)}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="search models…" value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.family} heading={group.family}>
                {group.options.map((option) => {
                  const key = refKey(option)
                  return (
                    <CommandItem
                      key={key}
                      value={key}
                      keywords={[option.family, option.runner, option.label, option.model]}
                      data-slot={`${slot}-option`}
                      onSelect={() => {
                        // Advisor options carry their provider family (the diversity
                        // axis) and have no effort dial — the config owns their tuning.
                        onPick(
                          option.runner === 'harness'
                            ? { runner: 'harness', model: option.model, family: option.family }
                            : { runner: option.runner, model: option.model, ...(value.effort ? { effort: value.effort } : {}) },
                        )
                        setOpen(false)
                        setSearch('')
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {option.runner} · {option.label}
                      </span>
                      {key === currentKey ? (
                        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                      ) : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {onAddModels ? (
          <button
            type="button"
            data-slot={`${slot}-add-models`}
            onClick={() => {
              setOpen(false)
              setSearch('')
              onAddModels()
            }}
            className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3 shrink-0" />
            Add more models…
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

const EFFORT_OPTIONS: ReadonlyArray<{ id: HarnessEffort | ''; label: string; desc: string }> = [
  { id: '', label: 'auto', desc: "The backend's default reasoning" },
  { id: 'low', label: 'low', desc: 'Fast and cheap — scoped, mechanical work' },
  { id: 'medium', label: 'medium', desc: 'Balanced reasoning' },
  { id: 'high', label: 'high', desc: 'Deep reasoning for hard problems' },
  { id: 'max', label: 'max', desc: 'Everything the model has' },
]

/** Per-role reasoning dial (user feedback 2026-07-24): the seam's neutral tiers, mapped per
 *  backend server-side (claude thinking budget, codex reasoning level; opencode ignores it). */
function EffortPill({
  slot,
  ariaLabel,
  value,
  onPick,
}: {
  slot: string
  ariaLabel: string
  value: HarnessEffort | undefined
  onPick: (effort: HarnessEffort | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-slot={slot} aria-label={ariaLabel} className={chipClass}>
          <span className="text-[11px] text-soft-foreground">effort</span>
          <span className="font-mono text-[11px]">{value ?? 'auto'}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-1">
        <ul role="listbox" aria-label={ariaLabel} className="flex flex-col">
          {EFFORT_OPTIONS.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={(value ?? '') === option.id}
                onClick={() => {
                  onPick(option.id === '' ? undefined : option.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <span className="w-14 shrink-0 font-mono text-xs font-medium">{option.label}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-soft-foreground">{option.desc}</span>
                {(value ?? '') === option.id ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** One lineup row (2026-07-24 layout): icon + uppercase label in a fixed column, the pills,
 *  and the role's one-line hint always UNDER the pills — one rhythm for every role instead
 *  of helper text floating wherever space allowed. */
function RoleRow({
  icon,
  label,
  hint,
  children,
}: {
  icon: ReactNode
  label: string
  hint: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start gap-2.5">
      <span className="flex w-[112px] shrink-0 items-center gap-1.5 pt-1 text-[11px] font-semibold tracking-[0.05em] text-soft-foreground uppercase">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">{children}</div>
        <span className="text-[11.5px] leading-relaxed text-soft-foreground">{hint}</span>
      </div>
    </div>
  )
}

/** Named lineups (user feedback 2026-07-24: "3 combinations I switch between") — chips that
 *  apply with one click, a save affordance for the current lineup, and per-chip delete. */
function PresetRow({
  roles,
  presets,
  onApply,
  onSave,
  onDelete,
}: {
  roles: HarnessRoles
  presets: readonly HarnessPreset[]
  onApply: (preset: HarnessPreset) => void
  onSave: (name: string) => void
  onDelete: (id: string) => void
}) {
  const [saveOpen, setSaveOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [name, setName] = useState('')
  // Header stability at any count ("what if 100 presets?"): a few chips
  // inline — the active one always among them — and the rest behind "+N more".
  const { visible, overflow } = visibleHarnessPresets(presets, roles)
  const saveCheck = canSaveHarnessPreset(presets, name.trim())
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-slot="harness-presets">
      {visible.map((preset) => {
        const active = rolesEqual(roles, preset.roles)
        return (
          <span key={preset.id} className="group/preset inline-flex items-center gap-0.5">
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onApply(preset)}
              className={cn(
                'inline-flex h-[26px] max-w-[160px] items-center rounded-full border px-2.5 text-xs font-medium transition-colors',
                active
                  ? 'border-primary/60 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="truncate">{preset.name}</span>
            </button>
            <button
              type="button"
              aria-label={`Delete preset ${preset.name}`}
              onClick={() => onDelete(preset.id)}
              className="inline-flex size-4 items-center justify-center rounded-full text-soft-foreground opacity-0 transition-opacity group-hover/preset:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        )
      })}
      {overflow.length > 0 ? (
        <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-slot="harness-presets-overflow"
              className="inline-flex h-[26px] items-center rounded-full border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              +{overflow.length} more
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[240px] p-1">
            <ul className="flex max-h-[16rem] flex-col overflow-y-auto" aria-label="More presets">
              {overflow.map((preset) => (
                <li key={preset.id} className="group/overflow flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(preset)
                      setOverflowOpen(false)
                    }}
                    className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-muted"
                  >
                    <span className="truncate">{preset.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete preset ${preset.name}`}
                    onClick={() => onDelete(preset.id)}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-soft-foreground hover:bg-muted hover:text-foreground"
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
      <Popover
        open={saveOpen}
        onOpenChange={(next) => {
          setSaveOpen(next)
          if (!next) setName('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Save preset"
            className="inline-flex h-[26px] items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <BookmarkPlusIcon aria-hidden="true" className="size-3" />
            Save preset
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[260px] p-2">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = name.trim()
              if (!trimmed || !canSaveHarnessPreset(presets, trimmed).ok) return
              onSave(trimmed)
              setSaveOpen(false)
              setName('')
            }}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                placeholder="preset name…"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus:border-ring"
              />
              <Button type="submit" size="sm" disabled={name.trim() === '' || !saveCheck.ok}>
                Save
              </Button>
            </div>
            {!saveCheck.ok ? (
              <p className="text-[11px] leading-relaxed text-danger">{saveCheck.reason}</p>
            ) : presets.some((p) => p.name === name.trim()) && name.trim() !== '' ? (
              <p className="text-[11px] leading-relaxed text-soft-foreground">
                Replaces the existing “{name.trim()}”.
              </p>
            ) : null}
          </form>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function HarnessPanel({
  mode,
  onMode,
  roles,
  onRoles,
  options,
  presets = [],
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onAddModels,
}: {
  mode: HarnessMode['id']
  onMode: (mode: HarnessMode['id']) => void
  /** Null while the workspace cannot offer a sound default (the modal case). */
  roles: HarnessRoles | null
  onRoles: (roles: HarnessRoles) => void
  options: readonly HarnessModelOption[]
  /** Saved lineups (2026-07-24). The row renders whenever the handlers are wired. */
  presets?: readonly HarnessPreset[]
  onApplyPreset?: (preset: HarnessPreset) => void
  onSavePreset?: (name: string) => void
  onDeletePreset?: (id: string) => void
  /** The always-findable path to more providers/models (2026-07-24). */
  onAddModels?: () => void
}) {
  const issue = roles ? harnessRolesIssue(roles) : null
  const freeTierWarning = freeTierReviewerWarning(roles)
  return (
    <section
      data-slot="harness-panel"
      aria-label="Multi-model run"
      className="mt-2.5 rounded-xl border border-border bg-card shadow-xs"
    >
      <div className="grid grid-cols-2 gap-2 px-4 pt-3.5 max-md:grid-cols-1" role="radiogroup" aria-label="What to run">
        {HARNESS_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === mode}
            onClick={() => onMode(option.id)}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-left transition-colors',
              option.id === mode
                ? 'border-primary/60 bg-card shadow-xs'
                : 'border-border bg-card-2 hover:bg-muted',
            )}
          >
            <span className={cn('text-[13px] font-semibold', option.id === mode ? 'text-foreground' : 'text-muted-foreground')}>
              {option.label}
            </span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-soft-foreground">{option.desc}</span>
          </button>
        ))}
      </div>

      {roles ? (
        <div className="flex flex-col gap-3 px-4 pt-3" data-slot="harness-roles">
          {/* Lineup header (user feedback 2026-07-24): presets live here, and
              "Add providers" is a first-class button at the TOP of the lineup
              — growing the roster is as much a part of composing a council as
              picking from it, not a footnote below the fold. */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border pt-3">
            <span className="text-[11px] font-semibold tracking-[0.05em] text-soft-foreground uppercase">
              Model lineup
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {onApplyPreset && onSavePreset && onDeletePreset ? (
                <PresetRow
                  roles={roles}
                  presets={presets}
                  onApply={onApplyPreset}
                  onSave={onSavePreset}
                  onDelete={onDeletePreset}
                />
              ) : null}
              {onAddModels ? (
                <button
                  type="button"
                  data-slot="harness-add-models"
                  onClick={onAddModels}
                  title="Install another backend (codex, opencode) or bind API provider models — runs the interactive setup task"
                  className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-violet/50 bg-violet/10 px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-violet/20"
                >
                  <PlusIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
                  Add providers
                </button>
              ) : null}
            </div>
          </div>

          <RoleRow
            icon={<WaypointsIcon aria-hidden="true" className="size-3.5 shrink-0" />}
            label="Orchestrator"
            hint="directs every phase — a 1M+ context model is recommended, it reads the most"
          >
            <ModelPickerPill
              slot="harness-orchestrator"
              ariaLabel="Orchestrator model"
              value={roles.orchestrator}
              options={options.filter((o) => o.runner !== 'harness')}
              onPick={(ref) => onRoles({ ...roles, orchestrator: ref })}
              onAddModels={onAddModels}
            />
            <EffortPill
              slot="harness-orchestrator-effort"
              ariaLabel="Orchestrator effort"
              value={roles.orchestrator.effort}
              onPick={(effort) => onRoles({ ...roles, orchestrator: { ...roles.orchestrator, effort } })}
            />
          </RoleRow>

          <RoleRow
            icon={<HammerIcon aria-hidden="true" className="size-3.5 shrink-0" />}
            label="Implementer"
            hint="writes the code and the fixes"
          >
            <ModelPickerPill
              slot="harness-implementer"
              ariaLabel="Implementer model"
              value={roles.implementer}
              options={options.filter((o) => o.runner !== 'harness')}
              onPick={(ref) => onRoles({ ...roles, implementer: ref })}
              onAddModels={onAddModels}
            />
            <EffortPill
              slot="harness-implementer-effort"
              ariaLabel="Implementer effort"
              value={roles.implementer.effort}
              onPick={(effort) => onRoles({ ...roles, implementer: { ...roles.implementer, effort } })}
            />
          </RoleRow>

          <RoleRow
            icon={<UsersRoundIcon aria-hidden="true" className="size-3.5 shrink-0" />}
            label="Reviewers"
            hint="each reviewer runs its own fresh review of the final diff; findings are merged — 2–5, unique, at least two model families"
          >
                {roles.reviewers.map((reviewer, index) => (
                  <span key={`${refKey(reviewer)}-${index}`} className="inline-flex items-center gap-1">
                    <ModelPickerPill
                      slot={`harness-reviewer-${index + 1}`}
                      ariaLabel={`Reviewer ${index + 1} model`}
                      value={reviewer}
                      options={options}
                      onPick={(ref) =>
                        onRoles({
                          ...roles,
                          reviewers: roles.reviewers.map((r, i) => (i === index ? ref : r)),
                        })
                      }
                      onAddModels={onAddModels}
                    />
                    {reviewer.runner !== 'harness' ? (
                      <EffortPill
                        slot={`harness-reviewer-${index + 1}-effort`}
                        ariaLabel={`Reviewer ${index + 1} effort`}
                        value={reviewer.effort}
                        onPick={(effort) =>
                          onRoles({
                            ...roles,
                            reviewers: roles.reviewers.map((r, i) => (i === index ? { ...r, effort } : r)),
                          })
                        }
                      />
                    ) : null}
                    {roles.reviewers.length > 2 ? (
                      <button
                        type="button"
                        aria-label={`Remove reviewer ${index + 1}`}
                        onClick={() =>
                          onRoles({ ...roles, reviewers: roles.reviewers.filter((_, i) => i !== index) })
                        }
                        className="inline-flex size-5 items-center justify-center rounded-full text-soft-foreground hover:bg-muted hover:text-foreground"
                      >
                        <XIcon aria-hidden="true" className="size-3" />
                      </button>
                    ) : null}
                  </span>
                ))}
                {roles.reviewers.length < 5 ? (
                  <button
                    type="button"
                    data-slot="harness-add-reviewer"
                    onClick={() => {
                      const used = new Set(roles.reviewers.map(refKey))
                      const next = options.find((o) => !used.has(refKey(o)))
                      if (next) {
                        onRoles({
                          ...roles,
                          reviewers: [
                            ...roles.reviewers,
                            next.runner === 'harness'
                              ? { runner: 'harness', model: next.model, family: next.family }
                              : { runner: next.runner, model: next.model },
                          ],
                        })
                      }
                    }}
                    className="inline-flex h-[26px] items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <PlusIcon aria-hidden="true" className="size-3" />
                    Add reviewer
                  </button>
                ) : null}
          </RoleRow>

          {issue ? (
            <p
              data-slot="harness-roles-issue"
              className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground"
            >
              <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-danger" />
              <span>{issue}</span>
            </p>
          ) : null}

          {/* Advisory, never blocking: a free-tier reviewer is a legitimate
              choice, it just frequently cannot finish in time. */}
          {freeTierWarning ? (
            <p
              data-slot="harness-free-tier-warning"
              className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground"
            >
              <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
              <span>{freeTierWarning}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 flex items-center gap-2 border-t border-border px-4 py-2 text-[11.5px] text-soft-foreground">
        <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
        Stage-only: the run cannot commit, push, or open a PR — it parks at Review with a verified
        staged diff, and you publish from there.
      </p>
    </section>
  )
}

/**
 * The blocking prompt when the workspace cannot field a multi-model council — fewer than two
 * model families available (user feedback 2026-07-24: no solo escape hatch in this tab; the
 * answer is configuring more models, exactly like the setup skill flow).
 */
export function HarnessSetupDialog({
  families,
  onConfigure,
  onBackToTask,
  onClose,
}: {
  /** The families currently available (e.g. ['anthropic']). */
  families: readonly string[]
  onConfigure: () => void
  onBackToTask: () => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-slot="harness-setup-dialog" className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Multi-model needs more than one model</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2 text-[13px] leading-relaxed">
              <p>
                {families.length === 1 ? (
                  <>
                    Only <span className="font-medium text-foreground">{families[0]}</span> models are
                    available here, and this tab runs a genuine council — reviewers from at least two
                    model families.
                  </>
                ) : (
                  <>No models are available yet — this tab runs a genuine council of several models.</>
                )}
              </p>
              <p>
                Add another backend (the <span className="font-mono text-[11.5px]">codex</span> or{' '}
                <span className="font-mono text-[11.5px]">opencode</span> CLI), or run the interactive
                setup task — it detects the providers you have, probes them, and stages the
                configuration for your review.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-1.5">
          <Button variant="ghost" size="sm" onClick={onBackToTask}>
            Back to Task
          </Button>
          <Button size="sm" onClick={onConfigure}>
            Configure models
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

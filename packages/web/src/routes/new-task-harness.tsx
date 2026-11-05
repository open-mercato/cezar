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
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import type {
  HarnessEffort,
  HarnessModelRef,
  HarnessPreset,
  HarnessProbeResponse,
  HarnessRoles,
  HarnessSkillProfile,
} from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
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
  modelFamilyOf,
  canSaveHarnessPreset,
  groupHarnessOptions,
  harnessRefDisplay,
  harnessRolesIssue,
  probeReadinessFor,
  reviewerOptions,
  freeTierReviewerWarning,
  rolesEqual,
  sessionRoleOptions,
  visibleHarnessPresets,
  type HarnessMode,
  type HarnessModelOption,
} from './new-task-harness-form'

/**
 * The Multi-model tab's surface (user feedback 2026-07-24): pick MODELS FOR ROLES, not a
 * preset topology. One orchestrator (the main agent — long context recommended, it reads the
 * most), one implementer, and 2–5 unique reviewers spanning at least two model families. The
 * route owns fetching and draft state; this stays presentational.
 *
 * The named execution profiles were removed from this surface (user feedback 2026-07-27): the
 * lineup IS the choice, and a second, coarser topology picker above it only asked the same
 * question twice. cezar no longer resolves `agentHarness.profiles` at all.
 */

/**
 * One readable line for a provider's readiness failure.
 *
 * Providers return operational prose meant for a terminal — codex nests the same
 * 400 twice inside its own exit message — and the raw text is kept verbatim
 * behind a disclosure. This is only the headline.
 */
export function humanReadinessError(detail: string): string {
  if (/not supported when using Codex with a ChatGPT account/i.test(detail)) {
    return "This Codex login can't run the selected model — pick a named model (e.g. gpt-5.6-luna), or bind an API key."
  }
  // Before the generic 403: OpenCode Zen answers a model switched off in the account's model
  // list with a 403 too, and "re-authenticate" sent the user after a key that was fine.
  if (/model access is disabled/i.test(detail)) {
    return 'This model is switched off for your account on the provider (OpenCode Zen: enable it in your Zen model settings) — enable it there or pick another model.'
  }
  if (/\b(401|403)\b|unauthor|invalid[_ -]?api[_ -]?key|authentication/i.test(detail)) {
    return 'The provider rejected the credentials for this binding — re-authenticate the CLI or update the API key.'
  }
  if (/\b429\b|rate.?limit|quota/i.test(detail)) {
    return 'The provider is rate-limiting or out of quota for this binding.'
  }
  if (/ENOENT|not found|command not found/i.test(detail)) {
    return 'The backend CLI for this binding is not installed or is not on PATH.'
  }
  if (/timed? ?out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(detail)) {
    return 'The binding could not be reached — the local server or the endpoint did not answer.'
  }
  if (/adapter missing|no endpoint|no credential/i.test(detail)) {
    return 'This model has no usable binding configured yet.'
  }
  const first = detail.split(/(?<=[.!?])\s|:\s/)[0] ?? detail
  return first.length > 140 ? `${first.slice(0, 137)}…` : first
}

const refKey = (ref: HarnessModelRef) => `${ref.runner}::${ref.model}`

function optionLabel(options: readonly HarnessModelOption[], ref: HarnessModelRef): string {
  const match = options.find((o) => o.runner === ref.runner && o.model === ref.model)
  return harnessRefDisplay(ref, match?.label)
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
  readiness,
}: {
  slot: string
  ariaLabel: string
  value: HarnessModelRef
  options: readonly HarnessModelOption[]
  onPick: (ref: HarnessModelRef) => void
  /** Pinned menu footer (2026-07-24): the always-visible path to more providers/models. */
  onAddModels?: () => void
  /** This model's live probe result (2026-07-27). Readiness sat 700px below the
   *  models it was judging; the verdict belongs ON the thing it is about. */
  readiness?: 'ready' | 'missing' | 'failed' | 'unknown'
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const groups = useMemo(() => groupHarnessOptions(options, search), [options, search])
  const listRef = useRef<HTMLDivElement>(null)
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
        <button
          type="button"
          data-slot={slot}
          aria-label={ariaLabel}
          data-readiness={readiness}
          className={cn(
            chipClass,
            readiness === 'failed' || readiness === 'missing' ? 'border-danger/50 bg-danger/5' : '',
          )}
        >
          {readiness ? (
            <StatusDot
              tone={
                readiness === 'ready' ? 'success'
                : readiness === 'failed' || readiness === 'missing' ? 'danger'
                : 'pending'
              }
              pulse={readiness === 'unknown'}
            />
          ) : null}
          <span className="font-mono text-meta">{optionLabel(options, value)}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="search models…" value={search} onValueChange={(next) => {
            setSearch(next)
            if (listRef.current) listRef.current.scrollTop = 0
          }} />
          <CommandList ref={listRef} className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            {groups.length === 0 ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
            {groups.map((group) => (
              <CommandGroup key={group.family} heading={group.family}>
                {group.options.map((option) => {
                  const key = refKey(option)
                  return (
                    <CommandItem
                      key={key}
                      value={key}
                      keywords={[
                        option.family,
                        option.runner,
                        option.label,
                        option.model,
                        harnessRefDisplay(option, option.label),
                        ...(option.desc ? [option.desc] : []),
                      ]}
                      data-slot={`${slot}-option`}
                      onSelect={() => {
                        onPick(
                          option.runner === 'harness'
                            ? { runner: 'harness', model: option.model, family: option.family }
                            : { runner: option.runner, model: option.model, ...(value.effort ? { effort: value.effort } : {}) },
                        )
                        setOpen(false)
                        setSearch('')
                      }}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs font-medium">
                          {harnessRefDisplay(option, option.label)}
                        </span>
                        {option.desc ? (
                          <span data-slot={`${slot}-option-desc`} className="truncate text-meta text-soft-foreground">
                            {option.desc}
                          </span>
                        ) : null}
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

const EFFORT_OPTIONS: ReadonlyArray<{
  id: HarnessEffort | ''
  label: string
  short: string
  desc: string
}> = [
  { id: '', label: 'auto', short: 'auto', desc: "The backend's default reasoning" },
  { id: 'low', label: 'low', short: 'low', desc: 'Fast and cheap — scoped, mechanical work' },
  { id: 'medium', label: 'medium', short: 'med', desc: 'Balanced reasoning' },
  { id: 'high', label: 'high', short: 'high', desc: 'Deep reasoning for hard problems' },
  { id: 'max', label: 'max', short: 'max', desc: 'Everything the model has' },
]

function handleRadioKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
  const current = radios.findIndex((radio) => radio === event.target)
  if (current === -1) return
  let next: number
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown': next = (current + 1) % radios.length; break
    case 'ArrowLeft':
    case 'ArrowUp': next = (current - 1 + radios.length) % radios.length; break
    case 'Home': next = 0; break
    case 'End': next = radios.length - 1; break
    default: return
  }
  event.preventDefault()
  radios[next]?.focus()
  radios[next]?.click()
}

/** Per-role tiers are translated by the harness before the native runner seam. */
function EffortSegments({
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
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-slot={slot}
      onKeyDown={handleRadioKeyDown}
      className="inline-flex h-[27px] shrink-0 overflow-hidden rounded-full border border-border"
    >
      {EFFORT_OPTIONS.map((option) => {
        const active = (value ?? '') === option.id
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={option.desc}
            onClick={() => onPick(option.id === '' ? undefined : option.id)}
            className={cn(
              'grid place-items-center border-r border-border px-2 text-micro transition-colors last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              active
                ? 'bg-muted font-semibold text-foreground'
                : 'text-soft-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {option.short}
          </button>
        )
      })}
    </div>
  )
}

function FamilyTag({ family }: { family: string }) {
  return (
    <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
      {family}
    </span>
  )
}

function RoleRow({
  icon,
  label,
  hint,
  effort,
  children,
}: {
  icon: ReactNode
  label: string
  hint: string
  effort?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[116px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border py-2.5 last:border-b-0 max-md:grid-cols-1">
      <span className="flex items-center gap-1.5 text-meta font-semibold tracking-[0.05em] text-soft-foreground uppercase">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
      {effort ?? <span />}
      <span className="col-start-2 text-meta leading-relaxed text-soft-foreground max-md:col-start-1">
        {hint}
      </span>
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
  const { visible, overflow } = visibleHarnessPresets(presets, roles)
  const saveCheck = canSaveHarnessPreset(presets, name.trim())
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-slot="harness-presets">
      {visible.map((preset) => {
        const active = rolesEqual(roles, preset.roles)
        return (
          <span key={preset.id} className="group/preset relative inline-flex items-center gap-0.5">
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
            <span
              role="tooltip"
              data-slot="harness-preset-preview"
              className="pointer-events-none absolute top-[30px] left-0 z-30 hidden w-[250px] rounded-lg border border-border bg-card p-2.5 shadow-md group-focus-within/preset:block group-hover/preset:block"
            >
              {(
                [
                  ['orchestrator', [preset.roles.orchestrator]],
                  ['implementer', [preset.roles.implementer]],
                  ['reviewers', preset.roles.reviewers],
                ] as const
              ).map(([label, refs]) => (
                <span key={label} className="flex gap-2 py-0.5">
                  <span className="w-[68px] shrink-0 pt-px text-[9.5px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
                    {label}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-micro text-muted-foreground">
                    {refs.map((ref) => (
                      <span key={`${ref.runner}::${ref.model}`} className="block truncate">
                        {harnessRefDisplay(ref)}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </span>
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
              <p className="text-meta leading-relaxed text-danger">{saveCheck.reason}</p>
            ) : presets.some((p) => p.name === name.trim()) && name.trim() !== '' ? (
              <p className="text-meta leading-relaxed text-soft-foreground">
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
  skillProfile = 'generic',
  onSkillProfile = () => {},
  probe,
  probePending = false,
  probeError,
  onRetryProbe,
  base,
  baseAcknowledgementReason = '',
  onBaseAcknowledgementReason,
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
  skillProfile?: HarnessSkillProfile
  onSkillProfile?: (profile: HarnessSkillProfile) => void
  probe?: HarnessProbeResponse
  probePending?: boolean
  probeError?: string
  onRetryProbe?: () => void
  base?: {
    configured: string | null
    remoteDefault: string | null
    stale: boolean
    note?: string
  }
  baseAcknowledgementReason?: string
  onBaseAcknowledgementReason?: (reason: string) => void
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
  const readinessOf = (ref: HarnessModelRef) => probeReadinessFor(probe, ref)
  const seatedReviewers = new Set(roles?.reviewers.map(refKey))
  const nextReviewer = reviewerOptions(options).find((option) => !seatedReviewers.has(refKey(option)))
  return (
    <section
      data-slot="harness-panel"
      aria-label="Multi-model run"
      className="mt-2.5 rounded-xl border border-border bg-card shadow-xs"
    >
      <div className="grid grid-cols-2 gap-2 px-4 pt-3.5 max-md:grid-cols-1" role="radiogroup" aria-label="What to run" onKeyDown={handleRadioKeyDown}>
        {HARNESS_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === mode}
            tabIndex={option.id === mode ? 0 : -1}
            onClick={() => onMode(option.id)}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              option.id === mode
                ? 'border-primary/60 bg-card shadow-xs'
                : 'border-border bg-card-2 hover:bg-muted',
            )}
          >
            <span className={cn('text-ui font-semibold', option.id === mode ? 'text-foreground' : 'text-muted-foreground')}>
              {option.label}
            </span>
            <span className="mt-0.5 block text-meta leading-snug text-soft-foreground">{option.desc}</span>
          </button>
        ))}
      </div>

      <div className="mx-4 mt-3 border-t border-border pt-3" data-slot="harness-skill-profile">
        <div className="mb-2">
          <span className="text-meta font-semibold tracking-[0.05em] text-soft-foreground uppercase">
            Development profile
          </span>
          <p className="mt-0.5 text-meta leading-snug text-soft-foreground">
            Your prompt stays a requirement brief; this selects the complete playbooks each structured phase follows.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1" role="radiogroup" aria-label="Development profile" onKeyDown={handleRadioKeyDown}>
          {([
            {
              id: 'generic',
              label: 'Generic project',
              desc: 'Repository-native specification, audit, implementation, testing, and review.',
            },
            {
              id: 'open-mercato',
              label: 'Open Mercato',
              desc: 'Canonical om-* skills and this repository’s Open Mercato extensions.',
            },
          ] as const).map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              data-skill-profile={option.id}
              aria-checked={skillProfile === option.id}
              tabIndex={skillProfile === option.id ? 0 : -1}
              onClick={() => onSkillProfile(option.id)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                skillProfile === option.id
                  ? 'border-violet/60 bg-violet/5 shadow-xs'
                  : 'border-border bg-card-2 hover:bg-muted',
              )}
            >
              <span className="text-label font-semibold text-foreground">{option.label}</span>
              <span className="mt-0.5 block text-meta leading-snug text-soft-foreground">
                {option.desc}
              </span>
            </button>
          ))}
        </div>
      </div>

      {roles ? (
        <div className="flex flex-col gap-3 px-4 pt-3" data-slot="harness-roles">
          {/* Lineup header (user feedback 2026-07-24): presets live here, and
              "Add providers" is a first-class button at the TOP of the lineup
              — growing the roster is as much a part of composing a council as
              picking from it, not a footnote below the fold. */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border pt-3">
            <span className="text-meta font-semibold tracking-[0.05em] text-soft-foreground uppercase">
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
            effort={
              <EffortSegments
                slot="harness-orchestrator-effort"
                ariaLabel="Orchestrator effort"
                value={roles.orchestrator.effort}
                onPick={(effort) => onRoles({ ...roles, orchestrator: { ...roles.orchestrator, effort } })}
              />
            }
          >
            <ModelPickerPill
              slot="harness-orchestrator"
              ariaLabel="Orchestrator model"
              readiness={readinessOf(roles.orchestrator)}
              value={roles.orchestrator}
              options={sessionRoleOptions(options)}
              onPick={(ref) => {
                if (ref.runner === 'harness') return
                onRoles({
                  ...roles,
                  orchestrator: {
                    runner: ref.runner,
                    model: ref.model,
                    ...(ref.effort ? { effort: ref.effort } : {}),
                  },
                })
              }}
              onAddModels={onAddModels}
            />
            <FamilyTag family={modelFamilyOf(roles.orchestrator)} />
          </RoleRow>

          <RoleRow
            icon={<HammerIcon aria-hidden="true" className="size-3.5 shrink-0" />}
            label="Implementer"
            hint="writes the code and the fixes"
            effort={
              <EffortSegments
                slot="harness-implementer-effort"
                ariaLabel="Implementer effort"
                value={roles.implementer.effort}
                onPick={(effort) => onRoles({ ...roles, implementer: { ...roles.implementer, effort } })}
              />
            }
          >
            <ModelPickerPill
              slot="harness-implementer"
              ariaLabel="Implementer model"
              readiness={readinessOf(roles.implementer)}
              value={roles.implementer}
              options={sessionRoleOptions(options)}
              onPick={(ref) => {
                if (ref.runner === 'harness') return
                onRoles({
                  ...roles,
                  implementer: {
                    runner: ref.runner,
                    model: ref.model,
                    ...(ref.effort ? { effort: ref.effort } : {}),
                  },
                })
              }}
              onAddModels={onAddModels}
            />
            <FamilyTag family={modelFamilyOf(roles.implementer)} />
          </RoleRow>

          <RoleRow
            icon={<UsersRoundIcon aria-hidden="true" className="size-3.5 shrink-0" />}
            label="Reviewers"
            hint="each reviewer runs its own fresh review of the final diff; findings are merged — 2–5, unique, at least two model families"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              {roles.reviewers.map((reviewer, index) => (
                <div
                  key={`${refKey(reviewer)}-${index}`}
                  className="flex min-w-0 flex-wrap items-center gap-1.5"
                >
                  <ModelPickerPill
                    slot={`harness-reviewer-${index + 1}`}
                    ariaLabel={`Reviewer ${index + 1} model`}
                    readiness={readinessOf(reviewer)}
                    value={reviewer}
                    options={reviewerOptions(options)}
                    onPick={(ref) =>
                      onRoles({
                        ...roles,
                        reviewers: roles.reviewers.map((r, i) => (i === index ? ref : r)),
                      })
                    }
                    onAddModels={onAddModels}
                  />
                  <FamilyTag family={modelFamilyOf(reviewer)} />
                  <span className="ml-auto flex items-center gap-1.5">
                    {reviewer.runner !== 'harness' ? (
                      <EffortSegments
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
                    ) : (
                      <span className="text-micro text-soft-foreground">configured</span>
                    )}
                    {roles.reviewers.length > 2 ? (
                      <button
                        type="button"
                        aria-label={`Remove reviewer ${index + 1}`}
                        onClick={() =>
                          onRoles({ ...roles, reviewers: roles.reviewers.filter((_, i) => i !== index) })
                        }
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-soft-foreground hover:bg-muted hover:text-foreground"
                      >
                        <XIcon aria-hidden="true" className="size-3" />
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
              {roles.reviewers.length < 5 ? (
                <button
                  type="button"
                  data-slot="harness-add-reviewer"
                  disabled={!nextReviewer}
                  title={!nextReviewer ? 'All available reviewer models are already in this lineup.' : undefined}
                  onClick={() => {
                    const next = nextReviewer
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
                  className="inline-flex h-[27px] w-fit items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <PlusIcon aria-hidden="true" className="size-3" />
                  Add reviewer
                </button>
              ) : null}
            </div>
          </RoleRow>

          {issue ? (
            <p
              data-slot="harness-roles-issue"
              className="flex items-start gap-2 text-label leading-relaxed text-muted-foreground"
            >
              <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-danger" />
              <span>{issue}</span>
            </p>
          ) : null}

          {freeTierWarning ? (
            <p
              data-slot="harness-free-tier-warning"
              className="flex items-start gap-2 text-label leading-relaxed text-muted-foreground"
            >
              <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
              <span>{freeTierWarning}</span>
            </p>
          ) : null}

          {/* Readiness belongs to the lineup now that the profile picker is gone (2026-07-27):
              the Start gate is this exact probe, so the evidence behind it has to be visible
              next to the models it is judging — not behind a topology tab. */}
          <div className="rounded-lg border border-border bg-card-2" data-slot="harness-profile-readiness">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
              <span className="font-semibold">Model readiness</span>
              <span className="text-soft-foreground">
                {probePending ? 'checking bindings…' : probeError ? 'check failed' : probe ? (probe.ready ? 'verified now' : probe.reason ?? 'not ready') : 'checking bindings…'}
              </span>
            </div>
            {probeError ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-danger">
                <span className="min-w-0 flex-1">{probeError}</span>
                {onRetryProbe ? (
                  <button
                    type="button"
                    onClick={onRetryProbe}
                    disabled={probePending}
                    aria-label="Retry readiness check"
                    className="rounded-md border border-border px-2 py-1 font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {probePending ? 'Checking…' : 'Try again'}
                  </button>
                ) : null}
              </div>
            ) : null}
            {(probe?.models ?? []).map((model) => {
              const failed = model.readiness === 'failed'
              const detail = model.readinessDetail ?? model.readiness ?? 'checking'
              return (
                <div
                  key={model.id}
                  className="grid grid-cols-[auto_minmax(5rem,.7fr)_minmax(0,1fr)] items-start gap-2 border-b border-border/70 px-3 py-2 text-xs last:border-0"
                >
                  <StatusDot
                    tone={
                      model.readiness === 'ready' ? 'success'
                      : failed ? 'danger'
                      : 'pending'
                    }
                    pulse={model.readiness === 'unknown'}
                  />
                  <span className="min-w-0 break-words font-semibold text-foreground">{model.id}</span>
                  <span className="min-w-0">
                    <span className="block break-all font-mono text-micro text-soft-foreground">
                      {model.binding}
                    </span>
                    {failed ? (
                      <>
                        <span className="mt-0.5 block leading-relaxed text-danger">
                          {humanReadinessError(detail)}
                        </span>
                        <details className="mt-1">
                          <summary className="cursor-pointer text-meta text-muted-foreground">
                            Show what the provider returned
                          </summary>
                          <pre className="mt-1 max-h-32 overflow-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-micro leading-relaxed whitespace-pre-wrap text-soft-foreground">
                            {detail}
                          </pre>
                        </details>
                      </>
                    ) : (
                      <span className="mt-0.5 block text-muted-foreground">{detail}</span>
                    )}
                  </span>
                </div>
              )
            })}
            {probe && !probe.ready ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {probe.reason ?? 'Every selected model must pass its live readiness probe.'}
                </span>
                {onRetryProbe && !probeError ? (
                  <button
                    type="button"
                    onClick={onRetryProbe}
                    disabled={probePending}
                    aria-label="Retry readiness check"
                    className="shrink-0 rounded-md border border-border px-2 py-1 text-meta font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {probePending ? 'Checking…' : 'Check again'}
                  </button>
                ) : null}
                {onAddModels ? (
                  <button
                    type="button"
                    data-slot="harness-fix-bindings"
                    onClick={onAddModels}
                    className="shrink-0 rounded-md border border-danger/40 px-2 py-1 text-meta font-semibold text-foreground hover:bg-danger/10"
                  >
                    Fix this
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {base?.stale && base.configured && base.remoteDefault ? (
        <div className="mx-4 mt-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5" data-slot="harness-stale-base">
          <p className="flex items-start gap-2 text-xs text-danger">
            <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>
              {base.note ?? `Configured base ${base.configured} differs from remote default ${base.remoteDefault}.`}
              {' '}Starting is blocked before worktree creation unless you update the base or acknowledge this exact pair.
            </span>
          </p>
          {onBaseAcknowledgementReason ? (
            <textarea
              aria-label="Reason for using a stale harness base"
              value={baseAcknowledgementReason}
              onChange={(event) => onBaseAcknowledgementReason(event.target.value)}
              placeholder="Why is this base intentional for this run?"
              className="mt-2 min-h-14 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-xs outline-none focus:border-ring"
            />
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 flex items-center gap-2 border-t border-border px-4 py-2 text-meta text-soft-foreground">
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
  advisorFamilies = [],
  onConfigure,
  onBackToTask,
  onClose,
}: {
  families: readonly string[]
  /** Configured advisor families (reviewer-only). Present but unusable alone —
   *  saying "no models are available" when three of these exist is false, and
   *  points at the wrong fix (review 2026-07-27). */
  advisorFamilies?: readonly string[]
  onConfigure: () => void
  onBackToTask: () => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-slot="harness-setup-dialog" className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>
            {advisorFamilies.length > 0 && families.length <= 1
              ? 'Multi-model needs a second agent backend'
              : 'Multi-model needs more than one model'}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2 text-ui leading-relaxed">
              <p>
                {advisorFamilies.length > 0 && families.length <= 1 ? (
                  <>
                    You have{' '}
                    <span className="font-medium text-foreground">
                      {advisorFamilies.length} configured reviewer{advisorFamilies.length > 1 ? 's' : ''}
                    </span>{' '}
                    ({advisorFamilies.join(', ')}), but they can only review. The orchestrator and the
                    implementer need an agent backend, and only{' '}
                    <span className="font-medium text-foreground">{families[0] ?? 'none'}</span> is
                    connected.
                  </>
                ) : families.length === 1 ? (
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
                Add another backend (the <span className="font-mono text-meta">codex</span> or{' '}
                <span className="font-mono text-meta">opencode</span> CLI), or run the interactive
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

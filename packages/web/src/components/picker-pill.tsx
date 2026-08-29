import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { DEFAULT_AGENT_ACCOUNT_ID, type Runner } from '@open-mercato/cezar-api-client'
import { RunnerLogo } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * The composer's single-choice pill, factored out of new-task.tsx (#401) so the follow-up
 * surface reuses the exact same runner/model control — one pill grammar, one place to change it.
 */

/** The mockup's `.chip`: a quiet bordered pill that darkens on hover. */
export const chipClass =
  // outline-none + the DS ring: without it the browser paints its own blue focus outline on the
  // pill (the one control that never declared a focus style of its own).
  'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-55'

export const chevron = (
  <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
)

/** A generic single-choice pill (runner / model / variants): DropdownMenu radio semantics,
 *  two-line items (label + quiet description), disabled state carries its reason as `title`. */
export function PickerPill({
  slot,
  ariaLabel,
  label,
  value,
  options,
  onPick,
  disabled = false,
  readOnly = false,
  hint,
  disabledHint,
  status,
}: {
  slot: string
  ariaLabel: string
  label: ReactNode
  value: string
  options: ReadonlyArray<{ value: string; label: string; desc?: string; icon?: ReactNode }>
  onPick: (value: string) => void
  disabled?: boolean
  /** Display the resolved value without presenting a selector. */
  readOnly?: boolean
  /** Hover explanation for the enabled pill — what the setting does (e.g. the ×1 variants pill). */
  hint?: string
  disabledHint?: string
  /** Quiet non-selectable catalog state, kept inside the menu's accessible reading order. */
  status?: string
}) {
  if (readOnly) {
    return (
      <span
        data-slot={slot}
        aria-label={ariaLabel}
        title={disabledHint ?? hint}
        className={`${chipClass} cursor-default hover:bg-card hover:text-muted-foreground`}
      >
        {label}
      </span>
    )
  }
  const trigger = (
    <button
      type="button"
      data-slot={slot}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? disabledHint : hint}
      className={chipClass}
    >
      {label}
      {chevron}
    </button>
  )
  // Radix never opens a disabled trigger, but `disabled:pointer-events-none` would also kill
  // the explanatory title tooltip — so the disabled pill renders bare, in a plain span wrapper
  // that still receives hover.
  if (disabled) {
    return (
      <span title={disabledHint} className="inline-flex">
        {trigger}
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={`${slot}-menu`}>
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2.5">
              {option.icon ? (
                <span className="flex size-4 shrink-0 items-center justify-center">{option.icon}</span>
              ) : null}
              <span className="flex min-w-0 flex-col">
                <span className="text-[12.5px] font-medium">{option.label}</span>
                {option.desc ? (
                  <span className="text-[11.5px] text-muted-foreground">{option.desc}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status ? (
          <DropdownMenuItem disabled className="border-t border-border text-[11.5px] text-muted-foreground">
            {status}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One agent account, as this pill needs to show it (spec 2026-07-29-agent-profiles).
 *
 * `id` is the reserved `default` for the DISCOVERED account — the one `agentHomePaths()` finds —
 * and a stored slug otherwise.
 */
export interface RunnerAccountChoice {
  provider: Runner
  id: string
  label: string
  /** The folder, as written. The labels are cezar's invention; the folder IS the account. */
  configDir: string
}

/** How one row of the pill's menu is addressed: the agent, and which of its logins. */
const choiceValue = (runner: Runner, account: string | null): string =>
  account === null ? runner : `${runner}:${account}`

/**
 * Which agent — and, when there is more than one login for it, which account — in ONE flat list:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner group with an account group nested under it. Every row is a concrete thing that can
 * run this task, so what will happen is readable at a glance instead of assembled from two
 * selections. An agent with a single login stays a single row, which is why a machine with no extra
 * accounts sees exactly the list it always saw.
 *
 * The pill renders for a CHOICE: more than one runner, or more than one account for one runner. A
 * host with one agent and one login has neither, and the caller leaves it out.
 *
 * Three wire states, and the difference between the first two matters:
 *   - `account === null` — follow the repo's setting. What an untouched pill means, and it stays
 *     true if that setting changes before the task starts.
 *   - `'default'` — the discovered account, EXPLICITLY. Beats the repo setting server-side
 *     (`selectProfile`), which is what makes "claude · Default" mean it in a repo set to another
 *     account.
 *   - a stored id — that account.
 */
export function RunnerPill({
  runners,
  value,
  onPick,
  disabled = false,
  accounts = [],
  account = null,
  repoAccount,
}: {
  runners: readonly Runner[]
  value: Runner
  /** `account` is `null` only while the repo's own choice is still the one in force. */
  onPick: (runner: Runner, account: string | null) => void
  disabled?: boolean
  /** Every login for every runner, discovered accounts included. Empty = the zero-config host. */
  accounts?: readonly RunnerAccountChoice[]
  /** The per-task override. */
  account?: string | null
  /** What the repo's setting resolves to per runner — the row that is selected until overridden. */
  repoAccount?: Partial<Record<Runner, string>>
}) {
  const available = RUNNERS.filter((r) => runners.includes(r.id))
  const options = available.flatMap(
    (runner): Array<{ value: string; label: string; desc?: string; icon?: ReactNode }> => {
      const logins = accounts.filter((entry) => entry.provider === runner.id)
      const icon = <RunnerLogo runner={runner.id} className="size-4" />
      // One login is not a choice, so it does not become a row of its own — the agent is the row.
      // Name only, no backend description subtitle — the row is just its agent's logo + name.
      if (logins.length < 2) return [{ value: choiceValue(runner.id, null), label: runner.id, icon }]
      return logins.map((login) => ({
        value: choiceValue(runner.id, login.id),
        label: `${runner.id} (${login.label})`,
        // The folder, because the label is cezar's invention and the folder is the account.
        desc: login.configDir,
        icon,
      }))
    },
  )

  // What is selected right now: the override if the user made one, else whatever the repo resolves
  // to, else the discovered account. Falls back to the plain runner row for an agent with one login
  // — and for an override naming an account that has since been deleted, which must not leave the
  // pill pointing at nothing.
  const selected = account ?? repoAccount?.[value] ?? DEFAULT_AGENT_ACCOUNT_ID
  const value_ = options.some((option) => option.value === choiceValue(value, selected))
    ? choiceValue(value, selected)
    : choiceValue(value, null)

  return (
    <PickerPill
      slot="runner-pill"
      ariaLabel="Runner"
      label={
        <span className="inline-flex items-center gap-1.5">
          <RunnerLogo runner={value} className="size-4" />
          {options.find((option) => option.value === value_)?.label ?? value}
        </span>
      }
      value={value_}
      disabled={disabled}
      onPick={(next) => {
        const [runner, picked] = next.split(':')
        onPick(runner as Runner, picked ?? null)
      }}
      options={options}
    />
  )
}

/**
 * Agent AND model in ONE pill (user decision: the composer row was carrying too much — the
 * model is an attribute of the agent, so one chip, one menu, two sections). The agent section
 * appears only when there is an agent/account choice to make; the model section always does.
 */
export function RunnerModelPill({
  runners,
  value,
  onPick,
  accounts = [],
  account = null,
  repoAccount,
  models,
  model,
  onPickModel,
  modelsLocked = false,
  modelStatus,
  disabled = false,
}: {
  runners: readonly Runner[]
  value: Runner
  onPick: (runner: Runner, account: string | null) => void
  accounts?: readonly RunnerAccountChoice[]
  account?: string | null
  repoAccount?: Partial<Record<Runner, string>>
  models: ReadonlyArray<{ id: string; label: string; desc?: string }>
  model: string
  onPickModel: (model: string) => void
  modelsLocked?: boolean
  modelStatus?: string
  disabled?: boolean
}) {
  const available = RUNNERS.filter((r) => runners.includes(r.id))
  const agentChoices = available.flatMap(
    (runner): Array<{ value: string; label: string; desc?: string }> => {
      const logins = accounts.filter((entry) => entry.provider === runner.id)
      if (logins.length < 2) return [{ value: choiceValue(runner.id, null), label: runner.id }]
      return logins.map((login) => ({
        value: choiceValue(runner.id, login.id),
        label: `${runner.id} (${login.label})`,
        desc: login.configDir,
      }))
    },
  )
  const hasAgentChoice =
    runners.length > 1 || runners.some((id) => accounts.filter((c) => c.provider === id).length > 1)
  const selected = account ?? repoAccount?.[value] ?? DEFAULT_AGENT_ACCOUNT_ID
  const agentValue = agentChoices.some((option) => option.value === choiceValue(value, selected))
    ? choiceValue(value, selected)
    : choiceValue(value, null)
  const modelLabel = models.find((m) => m.id === model)?.label ?? 'auto'

  const trigger = (
    <button
      type="button"
      data-slot="runner-pill"
      aria-label="Agent and model"
      disabled={disabled}
      className={chipClass}
    >
      <span className="inline-flex items-center gap-1.5">
        <RunnerLogo runner={value} className="size-4" />
        {agentChoices.find((option) => option.value === agentValue)?.label ?? value}, {modelLabel}
      </span>
      {chevron}
    </button>
  )
  if (disabled) return <span className="inline-flex">{trigger}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="runner-pill-menu">
        {hasAgentChoice ? (
          <>
            <DropdownMenuLabel className="text-[10.5px] font-semibold tracking-[0.05em] text-soft-foreground uppercase">
              Agent
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={agentValue}
              onValueChange={(next) => {
                const [runner, picked] = next.split(':')
                onPick(runner as Runner, picked ?? null)
              }}
            >
              {agentChoices.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} data-kind="agent-option" className="gap-2.5">
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <RunnerLogo runner={option.value.split(':')[0] as Runner} className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[12.5px] font-medium">{option.label}</span>
                    {option.desc ? (
                      <span className="text-[11.5px] text-muted-foreground">{option.desc}</span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="text-[10.5px] font-semibold tracking-[0.05em] text-soft-foreground uppercase">
          Model
        </DropdownMenuLabel>
        {modelsLocked ? (
          <DropdownMenuItem disabled className="text-[11.5px] text-muted-foreground">
            Model selection is locked to native coding-agent settings.
          </DropdownMenuItem>
        ) : (
          <DropdownMenuRadioGroup value={model} onValueChange={onPickModel}>
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id} data-kind="model-option" className="gap-2.5">
                <span className="flex min-w-0 flex-col">
                  <span className="text-[12.5px] font-medium">{m.label}</span>
                  {m.desc ? <span className="text-[11.5px] text-muted-foreground">{m.desc}</span> : null}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        {modelStatus ? (
          <DropdownMenuItem disabled className="border-t border-border text-[11.5px] text-muted-foreground">
            {modelStatus}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

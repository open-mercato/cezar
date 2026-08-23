import { SettingsIcon, WrenchIcon } from 'lucide-react'
import { Link } from '@/lib/project-router'
import { chevron } from '@/components/picker-pill'
import { cn } from '@/lib/utils'

import type { BackendCheck, HealthResponse, Runner } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The sidebar footer's Tools dropdown (spec, "App shell & navigation" footer): one compact
 * trigger — aggregate status dot + "Tools" — opening a menu that lists every tool the server
 * probed (`/api/health` `checks[]`), each with its status dot and version, a setup link when
 * unavailable, and a cog row into Settings → Agents.
 *
 * The rows are exactly `checks[]`, never a hardcoded tool list: what the menu claims is
 * installed is what the server actually probed, or the menu says nothing at all (no health
 * answer → no trigger — same honesty rule as the repo/version chips).
 */

/**
 * The version CELL is a number, not a sentence (the menu was drowning in raw probe strings like
 * "git version 2.50.1 (Apple Git-155)" and "mock (CEZ_DRY_RUN=1)"): pull the first dotted
 * version number out of whatever the tool printed, fall back to the first word for
 * versionless strings ("mock"). The verbatim probe output stays on the row as its tooltip.
 * Exported for the tests.
 */
export function conciseToolVersion(version: string): string {
  const number = version.match(/\d+(?:\.\d+)+\S*/)
  if (number) return number[0]
  return version.split(/[\s(]/, 1)[0] || version
}

/** The agent CLIs among `checks[]` — the tools a task actually needs one of. `gh` and `git` are
 *  the other rows; neither picks a runner. Spelled as an exhaustive `Record<Runner, true>` rather
 *  than a hand-kept list: the contract's runner enum is what `defaultRunner` is drawn from, so a
 *  fifth runner joining it (as `pi` did, #470) must fail the typecheck here instead of quietly
 *  dropping out of the trigger's idea of what can start a task. A type-level set, so no zod schema —
 *  and no zod — is pulled into the cockpit bundle for it. */
const RUNNER_NAMES: Record<Runner, true> = { claude: true, codex: true, opencode: true, pi: true }

const isRunner = (check: BackendCheck): boolean => Object.hasOwn(RUNNER_NAMES, check.name)

/**
 * What (if anything) keeps the aggregate trigger from resting quiet. Only two things do: having
 * no agent CLI at all, and the configured default runner being the missing one — those are what
 * stop a task from starting. An uninstalled *alternative* runner (or `gh`, "only needed for PR
 * creation") is a choice not taken, not a problem: the per-row red dot already says so.
 * Exported for the tests — the wording is a small contract of its own.
 */
export function toolsBlocker(health: HealthResponse): string | null {
  const runners = health.checks.filter(isRunner)
  if (runners.length && !runners.some((check) => check.available)) {
    return 'no agent CLI found, install one to run tasks'
  }
  // Absent from `checks[]` (an older server) means unprobed, not broken: nothing to claim.
  const preferred = runners.find((check) => check.name === health.defaultRunner)
  if (preferred && !preferred.available) {
    return `default runner (${health.defaultRunner}) not found`
  }
  return null
}

/** The trigger's hover tooltip: the cezar version, then the blocker if there is one — else
 *  the optional tools still worth knowing about. Exported for the tests. */
export function toolsTooltip(health: HealthResponse): string {
  const base = `cezar v${health.version}`
  const blocker = toolsBlocker(health)
  if (blocker) return `${base} (${blocker})`
  const missing = health.checks.filter((check) => !check.available).map((check) => check.name)
  return missing.length ? `${base} (optional: ${missing.join(', ')} not installed)` : base
}

/**
 * Why the GitHub tab is absent (R6 Step 1.1) — the env-chips popover is where the spec's
 * degradation table says the hint lives. Null while the forge works: a working forge needs
 * no explaining. Exported for the tests — the two sentences are a small contract.
 */
export function forgeNote(health: HealthResponse): string | null {
  if (health.forge?.available) return null
  if (!health.forge) {
    return 'No GitHub remote detected — the GitHub tab is hidden. Every plain-git feature still works.'
  }
  return `GitHub is unreachable — ${health.forge.reason ?? 'unknown reason'}. The GitHub tab is hidden until it comes back.`
}

export function ToolsMenu({ health }: { health: HealthResponse | undefined }) {
  if (!health) return null

  // Quiet when cez can actually work: at least one agent CLI is present and the default runner
  // is among them. Violet on the wrench otherwise — per-row dots are where red lives.
  const blocker = toolsBlocker(health)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="tools-menu-trigger"
          // The aggregate state rides the WRENCH (a dot next to "Tools" symbolized nothing):
          // quiet when a task can start, violet — the cockpit's "needs a human" hue, same as
          // the unread badges — only on a real BLOCKER (#884: no agent CLI, or the default
          // runner missing). A merely-optional missing tool keeps the trigger quiet; its own
          // row's red dot says so. The tooltip names whichever is the case.
          // Dressed like the bar's other utilities (Search, Settings): a quiet text button, no
          // frame (user decision).
          data-attention={blocker ? 'true' : undefined}
          title={toolsTooltip(health)}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <WrenchIcon
            aria-hidden="true"
            className={cn('size-3.5 shrink-0', blocker ? 'text-violet' : 'text-soft-foreground')}
          />
          Tools
          {chevron}
        </button>
      </DropdownMenuTrigger>

      {/* Anchored above the trigger — the trigger sits in the shell's bottom edge. */}
      <DropdownMenuContent
        side="top"
        align="start"
        data-slot="tools-menu-content"
        className="w-[240px]"
      >
        <DropdownMenuLabel className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
          Installed tools
        </DropdownMenuLabel>
        {health.checks.map((check) =>
          check.available ? <AvailableToolRow key={check.name} check={check} /> : <UnavailableToolRow key={check.name} check={check} />
        )}
        {forgeNote(health) ? (
          <>
            <DropdownMenuSeparator />
            <p data-slot="forge-note" className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
              {forgeNote(health)}
            </p>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/settings/agents"
            data-slot="tools-settings"
            className="gap-2 text-[12.5px] text-muted-foreground"
          >
            <SettingsIcon className="size-3.5" aria-hidden="true" />
            Tool settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A present tool: dot, mono name, right-aligned CONCISE version — the verbatim probe output
 *  ("git version 2.50.1 (Apple Git-155)") lives in the tooltip, not the column. Informational,
 *  not interactive — there is nothing to do to a tool that works. */
function AvailableToolRow({ check }: { check: BackendCheck }) {
  return (
    <div
      data-slot="tool-row"
      data-tool={check.name}
      data-available="true"
      title={check.version ?? undefined}
      className="flex items-center gap-2 rounded-sm px-2 py-1.5"
    >
      <StatusDot tone="success" />
      <span className="font-mono text-[12.5px] font-medium">{check.name}</span>
      <span
        data-slot="tool-version"
        className="ml-auto font-mono text-[11.5px] font-medium text-muted-foreground tabular-nums"
      >
        {check.version ? conciseToolVersion(check.version) : 'not found'}
      </span>
    </div>
  )
}

/**
 * A missing tool: ONE line — red dot, name, "Set up →" into Settings → Agents. The server's
 * `hint` (degradation doctrine: written for people) rides the row as its tooltip and waits in
 * full at the setup destination — printed inline it turned every missing tool into a paragraph
 * and the menu into a wall of text. The whole row is the link, so the menu closes on navigation.
 */
function UnavailableToolRow({ check }: { check: BackendCheck }) {
  return (
    <DropdownMenuItem asChild>
      <Link
        to="/settings/agents"
        data-slot="tool-row"
        data-tool={check.name}
        data-available="false"
        title={check.hint ?? undefined}
        className="gap-2"
      >
        <StatusDot tone="danger" />
        <span className="font-mono text-[12.5px] font-medium">{check.name}</span>
        <span data-slot="tool-setup" className="ml-auto shrink-0 text-[11.5px] font-semibold text-violet">
          Set up →
        </span>
      </Link>
    </DropdownMenuItem>
  )
}

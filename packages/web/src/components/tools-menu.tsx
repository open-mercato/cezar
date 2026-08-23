import { ChevronDownIcon, SettingsIcon } from 'lucide-react'
import { Link } from '@/lib/project-router'

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

/** The agent CLIs among `checks[]` — the tools a task actually needs one of. `gh` and `git` are
 *  the other rows; neither picks a runner. Spelled as an exhaustive `Record<Runner, true>` rather
 *  than a hand-kept list: the contract's runner enum is what `defaultRunner` is drawn from, so a
 *  fifth runner joining it (as `pi` did, #470) must fail the typecheck here instead of quietly
 *  dropping out of the dot's idea of what can start a task. A type-level set, so no zod schema —
 *  and no zod — is pulled into the cockpit bundle for it. */
const RUNNER_NAMES: Record<Runner, true> = { claude: true, codex: true, opencode: true, pi: true }

const isRunner = (check: BackendCheck): boolean => Object.hasOwn(RUNNER_NAMES, check.name)

/**
 * What (if anything) keeps the aggregate dot from green. Only two things do: having no agent
 * CLI at all, and the configured default runner being the missing one — those are what stop
 * a task from starting. An uninstalled *alternative* runner (or `gh`, "only needed for PR
 * creation") is a choice not taken, not a problem: the per-row red dot already says so.
 * Exported for the tests — the wording is a small contract of its own.
 */
export function toolsBlocker(health: HealthResponse): string | null {
  const runners = health.checks.filter(isRunner)
  if (runners.length && !runners.some((check) => check.available)) {
    return 'no agent CLI found — install one to run tasks'
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
  if (blocker) return `${base} · ${blocker}`
  const missing = health.checks.filter((check) => !check.available).map((check) => check.name)
  return missing.length ? `${base} · optional: ${missing.join(', ')} not installed` : base
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

  // Green when cez can actually work: at least one agent CLI is present and the default runner
  // is among them. `pending` (amber), not `danger`, otherwise — per-row dots are where red lives.
  const blocker = toolsBlocker(health)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="tools-menu-trigger"
          title={toolsTooltip(health)}
          className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <StatusDot tone={blocker ? 'pending' : 'success'} />
          Tools
          <ChevronDownIcon className="size-[11px]" aria-hidden="true" />
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

/** A present tool: dot, mono name, right-aligned version. Informational, not interactive —
 *  there is nothing to do to a tool that works. */
function AvailableToolRow({ check }: { check: BackendCheck }) {
  return (
    <div
      data-slot="tool-row"
      data-tool={check.name}
      data-available="true"
      className="flex items-center gap-2 rounded-sm px-2 py-1.5"
    >
      <StatusDot tone="success" />
      <span className="font-mono text-[12.5px] font-medium">{check.name}</span>
      <span
        data-slot="tool-version"
        className="ml-auto font-mono text-[11.5px] font-medium text-muted-foreground tabular-nums"
      >
        {check.version ?? 'not found'}
      </span>
    </div>
  )
}

/**
 * A missing tool: red dot + "not found", the server's `hint` verbatim as the secondary line
 * (degradation doctrine — the server writes those for people), and "Set up →" into Settings →
 * Agents. The whole row is the link, so the DropdownMenuItem closes the menu on navigation.
 */
function UnavailableToolRow({ check }: { check: BackendCheck }) {
  return (
    <DropdownMenuItem asChild>
      <Link
        to="/settings/agents"
        data-slot="tool-row"
        data-tool={check.name}
        data-available="false"
        className="flex-col items-stretch gap-1"
      >
        <span className="flex items-center gap-2">
          <StatusDot tone="danger" />
          <span className="font-mono text-[12.5px] font-medium">{check.name}</span>
          <span
            data-slot="tool-version"
            className="ml-auto font-mono text-[11.5px] font-medium text-muted-foreground"
          >
            not found
          </span>
        </span>
        <span className="flex items-end justify-between gap-3 pl-[15px]">
          {check.hint ? (
            <span data-slot="tool-hint" className="min-w-0 text-[11px] leading-snug text-muted-foreground">
              {check.hint}
            </span>
          ) : null}
          <span data-slot="tool-setup" className="ml-auto shrink-0 text-[11.5px] font-semibold text-violet">
            Set up →
          </span>
        </span>
      </Link>
    </DropdownMenuItem>
  )
}

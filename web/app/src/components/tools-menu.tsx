import { ChevronDownIcon, SettingsIcon } from 'lucide-react'
import { Link } from '@/lib/project-router'

import type { BackendCheck, HealthResponse } from '@/api/types'
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

/** The trigger's hover tooltip: the cezar version, plus whichever tools need attention.
 *  Exported for the tests — the string is a small contract of its own. */
export function toolsTooltip(health: HealthResponse): string {
  const missing = health.checks.filter((check) => !check.available).map((check) => check.name)
  const base = `cezar v${health.version}`
  return missing.length ? `${base} · needs attention: ${missing.join(', ')}` : base
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

  // Green only when nothing needs attention. `pending` (amber), not `danger`: a missing
  // optional tool is "worth a look", not an outage — the per-row dot is where red lives.
  const allAvailable = health.checks.every((check) => check.available)
  // The npm registry's newer version, when the server's update check found one (#368). A quiet
  // affordance, not an alert: a STATIC pending dot on the version row — updating is optional.
  const updateAvailable = Boolean(health.latestVersion && health.latestVersion !== health.version)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="tools-menu-trigger"
          title={toolsTooltip(health)}
          className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <StatusDot tone={allAvailable ? 'success' : 'pending'} />
          Tools
          <ChevronDownIcon className="size-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      {/* Anchored above the trigger — the trigger sits in the shell's bottom edge. */}
      <DropdownMenuContent
        side="top"
        align="start"
        data-slot="tools-menu-content"
        className="w-[240px]"
      >
        <DropdownMenuLabel className="label-caps">Installed tools</DropdownMenuLabel>
        {health.checks.map((check) =>
          check.available ? <AvailableToolRow key={check.name} check={check} /> : <UnavailableToolRow key={check.name} check={check} />
        )}
        {forgeNote(health) ? (
          <>
            <DropdownMenuSeparator />
            <p data-slot="forge-note" className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">
              {forgeNote(health)}
            </p>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/settings/agents"
            data-slot="tools-settings"
            className="gap-2 text-xs text-muted-foreground"
          >
            <SettingsIcon className="size-3.5" aria-hidden="true" />
            Tool settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div
          data-slot="tools-version"
          data-update-available={updateAvailable ? 'true' : undefined}
          className="flex items-center gap-2 px-2 py-1.5 font-mono text-2xs font-medium text-muted-foreground"
        >
          v{health.version}
          {updateAvailable ? (
            <span data-slot="tools-update" className="ml-auto flex items-center gap-1.5">
              <StatusDot tone="pending" />
              v{health.latestVersion} available
            </span>
          ) : null}
        </div>
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
      <span className="font-mono text-xs font-medium">{check.name}</span>
      <span
        data-slot="tool-version"
        className="ml-auto font-mono text-xs font-medium text-muted-foreground tabular-nums"
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
          <span className="font-mono text-xs font-medium">{check.name}</span>
          <span
            data-slot="tool-version"
            className="ml-auto font-mono text-xs font-medium text-muted-foreground"
          >
            not found
          </span>
        </span>
        <span className="flex items-end justify-between gap-3 pl-4">
          {check.hint ? (
            <span data-slot="tool-hint" className="min-w-0 text-2xs leading-snug text-muted-foreground">
              {check.hint}
            </span>
          ) : null}
          <span data-slot="tool-setup" className="ml-auto shrink-0 text-xs font-semibold text-violet">
            Set up →
          </span>
        </span>
      </Link>
    </DropdownMenuItem>
  )
}

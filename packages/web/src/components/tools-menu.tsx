import { ChevronDownIcon, SettingsIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import type { BackendCheck, HealthResponse, Runner } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { formatMem } from '@/lib/tasks-table'
import { Link } from '@/lib/project-router'
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
 *  new runner joining it (as `pi` did, #470, `cursor` did, #805, and `copilot` did, #582) must
 *  fail the typecheck here instead of quietly dropping out of the dot's idea of what can start a
 *  task. A type-level set, so no zod schema — and no zod — is pulled into the cockpit bundle for
 *  it. */
const RUNNER_NAMES: Record<Runner, true> = { claude: true, codex: true, junie: true, opencode: true, cursor: true, pi: true, copilot: true }

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
  // Below the floor the server refuses to start agents (9cdcedc3) — that stops a task too.
  if (health.disk?.level === 'critical') return `disk almost full — ${formatFree(health.disk.freeBytes)} free`
  return null
}

/** Health floors free space to 100 MiB steps once short, so a nearly full disk arrives as 0 —
 *  which `formatMem` renders as an empty string. */
function formatFree(bytes: number): string {
  return formatMem(bytes) || 'under 100 MB'
}

/**
 * The free-space warning (9cdcedc3): null while the disk is fine or the server could not probe it.
 * Points at the cleanup that already exists (#483 retention). Exported for the tests.
 */
export function diskNote(health: HealthResponse): string | null {
  const disk = health.disk
  if (!disk || disk.level === 'ok') return null
  const used = disk.worktreesBytes ? ` Task worktrees use ${formatMem(disk.worktreesBytes)}.` : ''
  const effect = disk.level === 'critical' ? ' New agents will not start until space is freed.' : ''
  return `Only ${formatFree(disk.freeBytes)} free on the disk holding task worktrees.${used}${effect} Reclaim finished tasks' worktrees (branches are kept) or delete old tasks.`
}

/** The trigger's hover tooltip: the cezar version, then the blocker if there is one — else
 *  the optional tools still worth knowing about. Exported for the tests. */
export function toolsTooltip(health: HealthResponse): string {
  const base = `cezar v${health.version}`
  const blocker = toolsBlocker(health)
  if (blocker) return `${base} · ${blocker}`
  const low = health.disk?.level === 'low' ? ` · low disk space (${formatFree(health.disk.freeBytes)} free)` : ''
  const missing = health.checks.filter((check) => !check.available).map((check) => check.name)
  if (low) return `${base}${low}`
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
  // A cold probe (no `available` yet) is not a failure — say nothing until it has answered.
  if (health.forge.available === undefined) return null
  return `GitHub is unreachable — ${health.forge.reason ?? 'unknown reason'}. The GitHub tab can retry.`
}

export function ToolsMenu({ health }: { health: HealthResponse | undefined }) {
  if (!health) return null

  // Green when cez can actually work: at least one agent CLI is present and the default runner
  // is among them. `pending` (amber), not `danger`, otherwise — per-row dots are where red lives.
  const blocker = toolsBlocker(health)
  const disk = diskNote(health)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="tools-menu-trigger"
          title={toolsTooltip(health)}
          className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <StatusDot tone={blocker || disk ? 'pending' : 'success'} />
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
        {disk ? (
          <>
            <DropdownMenuSeparator />
            <p data-slot="disk-note" className="px-2 pt-1.5 text-[11px] leading-snug text-muted-foreground">
              {disk}
            </p>
            <DropdownMenuItem asChild>
              <Link to="/settings/worktrees" data-slot="disk-reclaim" className="text-[11.5px] font-semibold text-violet">
                Manage worktrees →
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        {/* The tools listed above are MACHINE-wide CLIs, so their settings page is the machine's:
            General settings → Agent accounts (install hints, sign-in, the default agent) — not
            the per-project Agents page this row once pointed at. A plain router Link, on
            purpose: `/settings/global/*` lives outside every project, and the scoped Link would
            prefix it (or, outside any project, fall through the legacy redirect to the boot
            project — which is how "Tool settings" used to land on a stray worktree). */}
        <DropdownMenuItem asChild>
          <RouterLink
            to={ACCOUNTS_PATH}
            data-slot="tools-settings"
            className="gap-2 text-[12.5px] text-muted-foreground"
          >
            <SettingsIcon className="size-3.5" aria-hidden="true" />
            Agent accounts
          </RouterLink>
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

/** General settings → Agent accounts: where a machine-wide CLI is installed and signed in. */
const ACCOUNTS_PATH = '/settings/global/accounts'

/**
 * A missing tool: red dot + "not found", the server's `hint` verbatim as the secondary line
 * (degradation doctrine — the server writes those for people). For an AGENT, the whole row is a
 * "Set up →" link into Agent accounts on that agent's tab (`?agent=`), so the DropdownMenuItem
 * closes the menu on navigation; for `gh`/`git` the row is informational, like a present tool —
 * a link that cannot help is worse than none. `isRunner` (the exhaustive `RUNNER_NAMES` record
 * above) decides which is which, so a runner added to the contract cannot be missed here.
 */
function UnavailableToolRow({ check }: { check: BackendCheck }) {
  const body = (
    <>
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
      {check.hint || isRunner(check) ? (
        <span className="flex items-end justify-between gap-3 pl-[15px]">
          {check.hint ? (
            <span data-slot="tool-hint" className="min-w-0 text-[11px] leading-snug text-muted-foreground">
              {check.hint}
            </span>
          ) : null}
          {isRunner(check) ? (
            <span data-slot="tool-setup" className="ml-auto shrink-0 text-[11.5px] font-semibold text-violet">
              Set up →
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  )
  if (!isRunner(check)) {
    return (
      <div
        data-slot="tool-row"
        data-tool={check.name}
        data-available="false"
        className="flex flex-col items-stretch gap-1 rounded-sm px-2 py-1.5"
      >
        {body}
      </div>
    )
  }
  return (
    <DropdownMenuItem asChild>
      <RouterLink
        to={`${ACCOUNTS_PATH}?agent=${encodeURIComponent(check.name)}`}
        data-slot="tool-row"
        data-tool={check.name}
        data-available="false"
        className="flex-col items-stretch gap-1"
      >
        {body}
      </RouterLink>
    </DropdownMenuItem>
  )
}

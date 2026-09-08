import { ChevronDownIcon, ChevronRightIcon, NetworkIcon, PlusIcon, ShieldQuestionIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useHealth, useRuns } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
import { UnitRoleChip } from '@/components/unit-role-chip'
import { shortAge } from '@/lib/format'
import {
  budgetTone,
  buildMissionTrees,
  flattenMission,
  guardCount,
  missionUpdatedAt,
  type MissionNode,
  type MissionTree,
} from '@/lib/missions'
import { Link, useNavigate } from '@/lib/project-router'
import { formatCost } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * `/p/:projectId/missions` — the tree of unit runs (spec
 * `.ai/specs/2026-09-08-units-hierarchy.md` §Cockpit).
 *
 * Reads `useRuns()` and nothing else: the tree is DERIVED (`lib/missions.ts`), so it is already
 * live over the run stream and can never disagree with the Tasks table about a run's status. The
 * only extra request this page makes is the health one it shares with the whole shell.
 *
 * Status colour lives only in the dot, per the design system — the role chip, the meter and the
 * row itself stay neutral, and the one violet thing on the page is the Guard banner, which is
 * not a status but a call to act.
 */
export function MissionsRoute() {
  const health = useHealth()
  const runs = useRuns()
  const now = useNow(30_000)

  // Health first, exactly like the automations page: a bookmarked `/missions` URL still routes
  // here with the capability off, and the honest answer is the explainer, not an empty tree.
  // `!== true` deliberately — only a health payload that HAS answered turns the page on.
  if (health.data === undefined) {
    return (
      <MissionsFrame>
        <PageState text="Loading missions…" />
      </MissionsFrame>
    )
  }
  if (health.data.capabilities?.units !== true) return <UnitsOffState />

  const trees = buildMissionTrees(runs.data ?? [])
  const waiting = guardCount(trees)

  return (
    <MissionsFrame
      action={
        <Button asChild>
          <Link to="/missions/new">
            <PlusIcon aria-hidden="true" />
            New mission
          </Link>
        </Button>
      }
    >
      {waiting > 0 ? <GuardBanner count={waiting} /> : null}
      {runs.data === undefined ? (
        <PageState text="Loading missions…" />
      ) : trees.length === 0 ? (
        <MissionsEmptyState />
      ) : (
        <>
          <MissionsTable trees={trees} now={now} />
          <MissionCards trees={trees} now={now} />
        </>
      )}
    </MissionsFrame>
  )
}

/** The page chassis, shared with the Guard inbox so the two read as one area. */
export function MissionsFrame({
  title = 'Missions',
  subtitle = 'A mission is a tree of runs: Caesar commands legates, legates command centurions, and the centurions do the work.',
  icon,
  action,
  children,
}: {
  title?: string
  subtitle?: string
  /** The header glyph; the Missions network by default, so the Guard can wear its own shield
   *  while keeping the same chassis. */
  icon?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <main
      data-route="missions"
      className="mx-auto w-full max-w-6xl p-4 pb-[calc(90px+env(safe-area-inset-bottom))] sm:p-6 md:pb-6"
    >
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1.5 flex items-center gap-2 [&_svg]:size-5">
            {icon ?? <NetworkIcon aria-hidden="true" className="size-5" />}
            <h1 className="text-2xl font-semibold">{title}</h1>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </header>
      {children}
    </main>
  )
}

export function PageState({ text }: { text: string }) {
  return (
    <div
      data-slot="missions-state"
      className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
    >
      {text}
    </div>
  )
}

/** The gated-off explainer — the automations pattern, so both opt-in features refuse the same
 *  way and the copy names the env var that turns this one on. */
export function UnitsOffState() {
  return (
    <div data-route="missions" className="flex min-h-full flex-col p-3 md:p-5">
      <CenteredState
        icon={<NetworkIcon />}
        tone="neutral"
        title="Missions are off"
        subtitle="This server runs flat tasks only. Set CEZ_UNITS=1 and restart cezar to let a task command a tree of agents."
        heading="h2"
      />
    </div>
  )
}

/** The one violet surface on the page: N nodes are parked waiting for a human. Violet rather
 *  than amber because this is not a status — it is the Guard asking to be opened. */
function GuardBanner({ count }: { count: number }) {
  return (
    <div
      data-slot="guard-banner"
      className="mb-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-violet/25 bg-violet/10 px-3.5 py-2.5 text-[13px] text-foreground"
    >
      <ShieldQuestionIcon aria-hidden="true" className="size-4 shrink-0 text-violet" />
      <span>
        <strong className="font-semibold">{count}</strong> {count === 1 ? 'action is' : 'actions are'} waiting
        for the Guard
      </span>
      <Button asChild variant="outline" size="sm" className="sm:ml-auto">
        <Link to="/guard">Open the Guard</Link>
      </Button>
    </div>
  )
}

function MissionsEmptyState() {
  return (
    <CenteredState
      icon={<NetworkIcon />}
      tone="neutral"
      title="No missions yet"
      subtitle="A mission gives one objective to a commander that plans it, splits it across its own agents, and reports back once. Budgets cap the spend, and anything irreversible stops at the Guard first."
      heading="h2"
      actions={
        <Button asChild>
          <Link to="/missions/new">
            <PlusIcon aria-hidden="true" />
            New mission
          </Link>
        </Button>
      }
    />
  )
}

const TD = 'h-11 border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'
const TH =
  'h-9 border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.04em] text-soft-foreground uppercase first:pl-4 last:pr-4'

/** ≥md: the tree table. Indentation carries the hierarchy — one 22px step per depth, with the
 *  chevron sitting in that gutter, the way a file tree reads. */
function MissionsTable({ trees, now }: { trees: readonly MissionTree[]; now: number }) {
  return (
    <div
      data-slot="missions-table"
      className="hidden overflow-x-auto rounded-lg border border-border bg-card shadow-xs md:block"
    >
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={TH}>Mission</th>
            <th className={TH}>Status</th>
            <th className={TH}>Model</th>
            <th className={TH}>Budget</th>
            <th className={cn(TH, 'text-right')}>Agents</th>
            <th className={cn(TH, 'text-right')}>Updated</th>
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {trees.map((tree) => (
            <MissionRows key={tree.missionId} node={tree.root} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One mission root and its subtree, as sibling `<tr>`s.
 *
 * The collapse state is COMPONENT state and defaults to open: a mission is opened to be read,
 * and persisting the fold would mean a user who collapsed a finished mission last week silently
 * never sees the child that is waiting for them today. The banner counts the whole forest
 * regardless of what is folded, so nothing hides behind a chevron.
 */
function MissionRows({ node, now }: { node: MissionNode; now: number }) {
  const [open, setOpen] = useState(true)
  const navigate = useNavigate()
  const to = `/tasks/${node.run.id}`
  const hasChildren = node.children.length > 0

  return (
    <>
      <tr
        data-slot="mission-row"
        data-run-id={node.run.id}
        data-role={node.role}
        data-depth={node.depth}
        onClick={(event) => {
          if ((event.target as Element).closest('a, button')) return
          navigate(to)
        }}
        className="cursor-pointer hover:bg-muted"
      >
        <td className={cn(TD, 'max-w-0 min-w-[280px]')}>
          <div className="flex items-center gap-2" style={{ paddingLeft: node.depth * 22 }}>
            {hasChildren ? (
              <button
                type="button"
                data-action="mission-toggle"
                aria-expanded={open}
                aria-label={open ? `Collapse ${runTitle(node)}` : `Expand ${runTitle(node)}`}
                onClick={() => setOpen((current) => !current)}
                className="-ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:bg-muted hover:text-foreground"
              >
                {open ? (
                  <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                ) : (
                  <ChevronRightIcon aria-hidden="true" className="size-3.5" />
                )}
              </button>
            ) : (
              // A leaf still pays the chevron's width, so titles at one depth line up.
              <span aria-hidden="true" className="-ml-1 size-5 shrink-0" />
            )}
            <UnitRoleChip role={node.role} />
            <Link
              to={to}
              className="min-w-0 truncate text-[13px] font-medium text-foreground hover:underline"
            >
              {runTitle(node)}
            </Link>
          </div>
        </td>
        <td className={TD}>
          <Pill dot={node.attention.tone} pulse={node.attention.pulse}>
            {node.attention.label}
          </Pill>
        </td>
        <td className={cn(TD, 'font-mono text-[11.5px] text-muted-foreground')}>
          {node.run.model ?? '—'}
        </td>
        <td className={cn(TD, 'min-w-[150px]')}>
          <BudgetMeter node={node} />
        </td>
        <td className={cn(TD, 'text-right text-[12.5px] text-muted-foreground tabular-nums')}>
          {node.childCount || '—'}
        </td>
        <td className={cn(TD, 'text-right text-[12.5px] text-muted-foreground tabular-nums')}>
          {shortAge(missionUpdatedAt(node.run), now)}
        </td>
      </tr>
      {open
        ? node.children.map((child) => <MissionRows key={child.run.id} node={child} now={now} />)
        : null}
    </>
  )
}

/** 4px track, `bg-success` fill, amber from 70 %, danger over — and the numbers beside it, which
 *  are what a user actually reads. A node with no ceiling shows its spend and no meter: an empty
 *  bar would claim a limit nobody set. */
function BudgetMeter({ node }: { node: MissionNode }) {
  const spent = formatCost(node.costUsd) || '$0.00'
  if (node.budgetUsd === undefined) {
    return (
      <span data-slot="mission-budget" className="text-[12.5px] text-muted-foreground tabular-nums">
        {spent}
      </span>
    )
  }
  const tone = budgetTone(node.budgetRatio)
  // `Math.min` clamps an over-budget (and the zero-ceiling Infinity) node to a full bar — the
  // colour is what says "over", the width cannot say more than 100 %.
  const width = Math.min(100, Math.max(0, (node.budgetRatio ?? 0) * 100))
  return (
    <div data-slot="mission-budget" data-tone={tone} className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground tabular-nums">
        {spent} / ${node.budgetUsd}
      </span>
      <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
        <span
          data-slot="mission-budget-fill"
          className={cn(
            'block h-full rounded-full',
            tone === 'danger' ? 'bg-danger' : tone === 'pending' ? 'bg-pending' : 'bg-success',
          )}
          style={{ width: `${width}%` }}
        />
      </span>
    </div>
  )
}

/** <md: the same nodes as stacked cards, one per node, indented the same way. */
function MissionCards({ trees, now }: { trees: readonly MissionTree[]; now: number }) {
  const nodes = trees.flatMap((tree) => flattenMission(tree.root))
  return (
    <div data-slot="mission-cards" className="flex flex-col gap-2.5 md:hidden">
      {nodes.map((node) => (
        <Link
          key={node.run.id}
          to={`/tasks/${node.run.id}`}
          data-slot="mission-card"
          data-run-id={node.run.id}
          data-depth={node.depth}
          className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs"
          style={{ marginLeft: Math.min(node.depth, 2) * 14 }}
        >
          <div className="flex items-center gap-2">
            <UnitRoleChip role={node.role} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{runTitle(node)}</span>
            <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
              {shortAge(missionUpdatedAt(node.run), now)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill dot={node.attention.tone} pulse={node.attention.pulse}>
              {node.attention.label}
            </Pill>
            <BudgetMeter node={node} />
            {node.childCount > 0 ? (
              <span className="text-[12px] text-muted-foreground tabular-nums">
                {node.childCount} {node.childCount === 1 ? 'agent' : 'agents'}
              </span>
            ) : null}
          </div>
        </Link>
      ))}
    </div>
  )
}

/** A node's row title. `title` is what the namer wrote; a run that has none yet is named by its
 *  own task text rather than by a placeholder, which is what the Tasks table does too. */
export function runTitle(node: MissionNode): string {
  return node.run.title || node.run.task || node.run.id
}

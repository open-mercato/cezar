import { ShieldCheckIcon } from 'lucide-react'

import { useHealth, useRuns } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { UnitRoleChip } from '@/components/unit-role-chip'
import { shortAge } from '@/lib/format'
import { buildMissionTrees, guardQueue, missionUpdatedAt } from '@/lib/missions'
import { Link } from '@/lib/project-router'
import { useNow } from '@/lib/use-now'

import { MissionsFrame, PageState, UnitsOffState, runTitle } from './missions'

/**
 * `/p/:projectId/guard` — the Guard inbox (spec `2026-09-08-units-hierarchy` Q4).
 *
 * A FILTERED VIEW, not a new surface: the rows are the mission tree's `needsGuard` nodes, and
 * the approval itself happens in the thread, on the `CEZ:ASK` card that is already the cockpit's
 * one approval UI. That is the whole reason the Guard needed no new marker, route or record
 * field — so this page deliberately ends at "Open" rather than growing approve/deny buttons of
 * its own, which would be a second place for the same decision to be made differently.
 *
 * Flat, newest first, across every mission: what is waiting for you is a queue, not a tree.
 */
export function GuardRoute() {
  const health = useHealth()
  const runs = useRuns()
  const now = useNow(30_000)

  if (health.data === undefined) {
    return (
      <MissionsFrame title="Guard" subtitle={SUBTITLE} icon={<ShieldCheckIcon aria-hidden="true" />}>
        <PageState text="Loading the Guard…" />
      </MissionsFrame>
    )
  }
  if (health.data.capabilities?.units !== true) return <UnitsOffState />

  const queue = guardQueue(buildMissionTrees(runs.data ?? []))

  return (
    <MissionsFrame title="Guard" subtitle={SUBTITLE}>
      {runs.data === undefined ? (
        <PageState text="Loading the Guard…" />
      ) : queue.length === 0 ? (
        <CenteredState
          icon={<ShieldCheckIcon />}
          tone="neutral"
          title="Nothing is waiting for you."
          subtitle="A unit run stops here before anything irreversible, financial or scope-widening. When one does, it appears in this queue."
          heading="h2"
        />
      ) : (
        <ul data-slot="guard-queue" className="flex flex-col gap-2">
          {queue.map(({ node, mission }) => (
            <li
              key={node.run.id}
              data-slot="guard-row"
              data-run-id={node.run.id}
              className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 shadow-xs"
            >
              <UnitRoleChip role={node.role} />
              {node.parkReason ? (
                <span
                  data-slot="guard-reason"
                  className="rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {node.parkReason === 'question' ? 'question' : 'parked'}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {runTitle(node)}
              </span>
              <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                {runTitle(mission.root)}
              </span>
              <span className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">
                {shortAge(missionUpdatedAt(node.run), now)}
              </span>
              <Button asChild variant="outline" size="sm">
                <Link to={`/tasks/${node.run.id}`}>Open</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </MissionsFrame>
  )
}

const SUBTITLE =
  'Every unit run that stopped to ask. Opening one lands on its question in the thread, which is where you answer it.'

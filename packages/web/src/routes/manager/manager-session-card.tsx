import { ChevronRightIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useRunsIndex } from '@/api/queries'
import { DiffStatLabel } from '@/components/diff-stat'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import type { ManagerOrigin } from '@/lib/managers'
import { runTitle } from '@/lib/task-groups'
import type { RunRecord } from '@open-mercato/cezar-api-client'

export function taskPath(projectId: string, runId: string): string {
  return `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(runId)}`
}

/** A `[[task:…]]`: title, live status and +/− from the runs index, a way into that task's thread. */
export function SessionCard({
  projectId,
  runId,
  origin,
}: {
  projectId: string
  runId: string
  origin: ManagerOrigin
}) {
  const index = useRunsIndex()
  const run = index.data?.runs.find((entry) => entry.projectId === projectId && entry.id === runId)
  const stat = run?.diffStat
  const attention = run ? deriveAttention(run as unknown as RunRecord) : undefined
  return (
    <div className="my-3">
      <p className="mb-1.5 text-xs font-semibold text-foreground">{origin.name}</p>
      <Link
        to={taskPath(projectId, runId)}
        state={{ manager: origin }}
        data-slot="session-card"
        data-run={runId}
        className="flex w-full max-w-64 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {run ? runTitle(run as unknown as RunRecord) : `Session ${runId.slice(0, 8)}`}
          </span>
          {attention || stat ? (
            <span className="mt-0.5 flex min-h-4 items-center gap-2">
              {attention ? (
                <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                  <StatusDot tone={attention.tone} pulse={attention.pulse} />
                  {attention.label}
                </span>
              ) : null}
              {stat ? <DiffStatLabel stat={stat} /> : null}
            </span>
          ) : null}
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-5 shrink-0" />
      </Link>
    </div>
  )
}

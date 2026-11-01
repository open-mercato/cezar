import { useProjectRepoBase, useRuns } from '@/api/queries'
import type { GithubItem } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { relatedTasks } from '@/lib/tasks-table'
import { runTitle } from '@/lib/task-groups'

/** Tasks of this project that worked on the issue/PR, active and archived, newest first (#1048). */
export function GithubRelatedTasks({ item }: { item: Pick<GithubItem, 'kind' | 'number'> }) {
  const runs = useRuns()
  const repoBase = useProjectRepoBase()
  const related = relatedTasks(Array.isArray(runs.data) ? runs.data : [], item, repoBase)
  return (
    <section data-slot="gh-related-tasks" aria-label="Related tasks" className="mt-6 text-sm">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Related tasks</h3>
      {related.length === 0 ? (
        <p data-slot="gh-related-empty" className="text-soft-foreground">
          {runs.isPending ? 'Loading…' : 'No retained tasks reference this yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {related.map((run) => {
            const attention = deriveAttention(run)
            return (
              <li key={run.id}>
                <Link
                  to={`/tasks/${encodeURIComponent(run.id)}`}
                  data-slot="gh-related-task"
                  className="flex items-center gap-2 px-3 py-2 hover:bg-accent"
                >
                  <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
                  <span className="min-w-0 flex-1 truncate">{runTitle(run)}</span>
                  {run.archived ? <span className="text-[10.5px] text-soft-foreground">archived</span> : null}
                  <span className="shrink-0 text-xs text-soft-foreground">
                    {attention.label} · {shortAge(run.createdAt)} ago
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

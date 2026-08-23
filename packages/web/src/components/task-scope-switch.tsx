import { Link as RouterLink } from 'react-router'

import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The one Tasks page, two scopes (user decision: "Tasks" and "All tasks" as two nav rows read as
 * two categories of the same thing). This segmented pair sits in the page header beside
 * Active/Archived and moves between the project's table (`/`, scoped) and the workspace-wide
 * one (`/tasks`, global). Multi-project only — with one project the two tables are the same
 * table, and the switch would be a choice between identical things.
 *
 * Links, not buttons: the two scopes are two routes, and a deep link to either must work.
 * Presentational: the route decides `visible` from what it already holds (health's project
 * list, or the registry) — no query of its own, so bare page renders stay query-free.
 */
export function TaskScopeSwitch({ scope, visible }: { scope: 'project' | 'all'; visible: boolean }) {
  if (!visible) return null
  return (
    <div data-slot="task-scope-switch" className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]">
      <Link to="/" data-scope="project" aria-current={scope === 'project' ? 'page' : undefined} className={tabClass(scope === 'project')}>
        This project
      </Link>
      {/* A PLAIN router link: the global page sits outside every project, and the scoped Link
          would prefix it with `/p/<id>`, which is no route. */}
      <RouterLink to="/tasks" data-scope="all" aria-current={scope === 'all' ? 'page' : undefined} className={tabClass(scope === 'all')}>
        All projects
      </RouterLink>
    </div>
  )
}

function tabClass(active: boolean): string {
  return cn(
    'flex h-7 items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground',
    active && 'bg-card font-semibold text-foreground shadow-xs',
  )
}

import { PlusIcon } from 'lucide-react'
import { Outlet } from 'react-router'

import { useHealth, useRunsForProject } from '@/api/queries'
import { ContextSidebar } from '@/components/context-sidebar'
import { useListView } from '@/components/list-view'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { Button } from '@/components/ui/button'
import { SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader } from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { listCounts, type ListView } from '@/lib/task-groups'

/**
 * The Tasks area's contextual sidebar: every task of the project, grouped Needs you / Working /
 * Recent, with the Active | Archived switch the Tasks table shares (one filter, two places).
 * It stays put while you move between the list, a task and the composer, which is the point —
 * the list is how you get from one task to the next without going back.
 */
export function TasksSidebar() {
  const [view, setView] = useListView()
  const health = useHealth()
  const projectId = useActiveProjectId()
  const runs = useRunsForProject(projectId, health.data?.bootProject ?? null)
  const counts = runs.data ? listCounts(runs.data) : null

  return (
    <ContextSidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Tasks</h2>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to="/new">
              <PlusIcon aria-hidden="true" />
              New
            </Link>
          </Button>
        </div>
        <Tabs value={view} onValueChange={(next) => setView(next as ListView)}>
          <TabsList className="w-full">
            <TabsTrigger value="active" data-slot="view-tab" data-view="active">
              Active
              {counts?.active ? <span className="font-mono text-[11px] tabular-nums opacity-70">{counts.active}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="archived" data-slot="view-tab" data-view="archived">
              Archived
              {counts?.archived ? (
                <span className="font-mono text-[11px] tabular-nums opacity-70">{counts.archived}</span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-0">
          <SidebarGroupContent data-slot="task-quick-list" className="@container/sidebar">
            <TaskQuickListContainer limit={Number.POSITIVE_INFINITY} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </ContextSidebar>
  )
}

/** The layout route of the Tasks area: mounts the sidebar once for every task URL beneath it. */
export function TasksAreaLayout() {
  return (
    <>
      <TasksSidebar />
      <Outlet />
    </>
  )
}

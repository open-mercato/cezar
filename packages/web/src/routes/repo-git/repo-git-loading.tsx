import { ContextSidebar } from '@/components/context-sidebar'
import { Page, PageBody } from '@/components/page'
import { SidebarContent, SidebarGroup, SidebarHeader } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'

/** The repo view's loading surface — also the route's `Suspense` fallback (routes.tsx), so it
 *  lives outside the lazy chunk it stands in for, same reason as git-tab-loading.tsx. It fills
 *  the contextual sidebar too, so the column does not pop in when the repository arrives. */
export function RepoGitLoading() {
  return (
    <Page data-route="repo-git" width="full" aria-busy="true">
      <ContextSidebar>
        <SidebarHeader className="gap-3 p-3">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Git</h2>
          <Skeleton className="h-9 w-full" />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="gap-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-1/2" />
          </SidebarGroup>
        </SidebarContent>
      </ContextSidebar>
      <PageBody className="space-y-2 pt-6">
        <span className="sr-only">Loading repository…</span>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-2/3" />
      </PageBody>
    </Page>
  )
}

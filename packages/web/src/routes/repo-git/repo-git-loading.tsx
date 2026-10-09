import { Page, PageBody, PageHeader } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'

/** The repo view's loading surface — also the route's `Suspense` fallback (routes.tsx), so it
 *  lives outside the lazy chunk it stands in for, same reason as git-tab-loading.tsx. */
export function RepoGitLoading() {
  return (
    <Page data-route="repo-git" width="wide" aria-busy="true">
      <PageHeader title="Git" description="Loading repository…">
        <Skeleton className="h-9 w-64" />
      </PageHeader>
      <PageBody className="space-y-2">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-2/3" />
      </PageBody>
    </Page>
  )
}

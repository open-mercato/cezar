import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/** The repo view's loading surface — also the route's `Suspense` fallback (routes.tsx), so it
 *  lives outside the lazy chunk it stands in for, same reason as git-tab-loading.tsx. */
export function RepoGitLoading() {
  return (
    <div data-route="repo-git" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading repository…"
        subtitle="Fetching the repo's git state."
      />
    </div>
  )
}

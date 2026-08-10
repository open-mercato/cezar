import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/**
 * The Workflows builder's loading state, in its own module ON PURPOSE (same rule as
 * GithubLoading): it is both the route's fetch-pending state and the `Suspense` fallback for
 * the lazily-loaded workflows chunk (routes.tsx) — and the fallback must not import anything
 * from that chunk, or the split that keeps dnd-kit off the main bundle quietly disappears.
 */
export function WorkflowsLoading() {
  return (
    <div data-route="workflows" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading workflows…"
        subtitle="Fetching the saved chains and the skills palette."
      />
    </div>
  )
}

import { Skeleton } from '@/components/ui/skeleton'

/**
 * The Workflows builder's loading state, in its own module ON PURPOSE (same rule as
 * GithubLoading): it is both the route's fetch-pending state and the `Suspense` fallback for
 * the lazily-loaded workflows chunk (routes.tsx) — and the fallback must not import anything
 * from that chunk, or the split that keeps React Flow off the main bundle quietly disappears.
 */
export function WorkflowsLoading() {
  return (
    <div data-route="workflows" aria-busy="true" aria-label="Loading workflows…" className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="ml-auto h-8 w-20" />
      </div>
      <div className="flex flex-1 items-center justify-center gap-6">
        <Skeleton className="size-16 rounded-xl" />
        <Skeleton className="h-16 w-48 rounded-xl" />
        <Skeleton className="size-16 rounded-xl" />
      </div>
    </div>
  )
}

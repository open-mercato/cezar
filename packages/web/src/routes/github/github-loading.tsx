import { ContextSidebar } from '@/components/context-sidebar'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The GitHub tab's loading state, in its own module ON PURPOSE (same rule as ThreadLoading):
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * github chunk (routes.tsx) — and the fallback must not import anything from that chunk, or
 * the split that keeps the markdown stack off the main bundle quietly disappears.
 */
export function GithubLoading() {
  return (
    <div data-route="github" aria-busy="true" aria-label="Loading GitHub…" className="flex min-h-full flex-col">
      <ContextSidebar>
        <div className="flex flex-col gap-4 p-4">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ))}
        </div>
      </ContextSidebar>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-5 md:px-10 md:pt-8">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-4 h-32 w-full max-w-2xl" />
      </div>
    </div>
  )
}

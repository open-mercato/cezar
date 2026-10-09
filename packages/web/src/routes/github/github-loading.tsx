import { Skeleton } from '@/components/ui/skeleton'

/**
 * The GitHub tab's loading state, in its own module ON PURPOSE (same rule as ThreadLoading):
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * github chunk (routes.tsx) — and the fallback must not import anything from that chunk, or
 * the split that keeps the markdown stack off the main bundle quietly disappears.
 */
export function GithubLoading() {
  return (
    <div data-route="github" aria-busy="true" aria-label="Loading GitHub…" className="flex h-full min-h-0 items-stretch">
      <div className="flex w-full flex-col gap-4 border-border px-4 pt-5 md:w-[380px] md:shrink-0 md:border-r">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        ))}
      </div>
      <div className="hidden flex-1 flex-col gap-4 px-10 pt-8 md:flex">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-4 h-32 w-full max-w-2xl" />
      </div>
    </div>
  )
}

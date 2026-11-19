import { ChatSkeleton, LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The thread's loading state, in its own module ON PURPOSE: it is both the route's
 * fetch-pending state and the `Suspense` fallback for the lazily-loaded thread chunk
 * (routes.tsx) — and the fallback must not import anything from that chunk, or the split
 * that keeps Streamdown/remark off the main bundle quietly disappears.
 */
export function ThreadLoading() {
  return (
    <div data-route="task-thread" className="flex min-h-full flex-col">
      <h1 className="sr-only">Loading task…</h1>
      <LoadingState label="Fetching the run and its session transcript." className="flex flex-1 flex-col">
        <div className="flex flex-col gap-2 border-b border-border px-3 pt-2 pb-3 md:px-6 md:pt-3">
          <Skeleton className="h-5 w-2/3 max-w-md md:h-6" />
          <div className="flex gap-2">
            <Skeleton className="h-4 w-16 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="mt-1 flex gap-4">
            {['w-14', 'w-16', 'w-12', 'w-14'].map((width, index) => <Skeleton key={index} className={`h-3.5 ${width}`} />)}
          </div>
        </div>
        <ChatSkeleton className="mx-auto w-full max-w-[var(--measure)] px-3 py-3 md:px-6 md:py-5" />
      </LoadingState>
    </div>
  )
}

import { Page, PageBody, PageRow } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The compare view's loading state — like thread-loading.tsx, in its own module ON PURPOSE:
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * compare chunk (routes.tsx), and the fallback must not import anything from that chunk or the
 * split (Streamdown for the Progress excerpts, Shiki for the diffs) quietly disappears.
 */
export function CompareLoading() {
  return (
    <Page data-route="compare" aria-busy="true">
      <PageRow className="space-y-2 pt-6 pb-4 sm:pt-8">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <span className="sr-only">Loading variants…</span>
      </PageRow>
      <PageBody>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1].map((column) => (
            <div key={column} className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </PageBody>
    </Page>
  )
}

import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/**
 * The compare view's loading state — like thread-loading.tsx, in its own module ON PURPOSE:
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * compare chunk (routes.tsx), and the fallback must not import anything from that chunk or the
 * split (Streamdown for the Progress excerpts, Shiki for the diffs) quietly disappears.
 */
export function CompareLoading() {
  return (
    <div data-route="compare" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading variants…"
        subtitle="Fetching every variant's status, spend and diff summary."
      />
    </div>
  )
}

import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/**
 * The units surfaces' loading state, in its own module ON PURPOSE (same rule as
 * `WorkflowsLoading`): it is the `Suspense` fallback for the lazily-loaded missions chunk
 * (routes.tsx), and a fallback that imported anything from that chunk would quietly undo the
 * split it exists to cover.
 */
export function MissionsLoading() {
  return (
    <div data-route="missions" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading missions…"
      />
    </div>
  )
}

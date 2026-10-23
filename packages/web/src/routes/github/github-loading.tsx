import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'
import { forgeLabel, forgePrNoun } from '@/lib/forge-display'
import type { ForgeKind } from '@open-mercato/cezar-api-client'

/**
 * The GitHub tab's loading state, in its own module ON PURPOSE (same rule as ThreadLoading):
 * it is both the route's fetch-pending state and the `Suspense` fallback for the lazily-loaded
 * github chunk (routes.tsx) — and the fallback must not import anything from that chunk, or
 * the split that keeps the markdown stack off the main bundle quietly disappears.
 *
 * `forgeKind` is optional (Step 3.8-review-fix): the Suspense-fallback call sites in routes.tsx
 * render before `useHealth()` has ever resolved, so they mount this with no kind at all — which,
 * like everywhere else in the tab, reads as GitHub. Only the route's own fetch-pending render
 * (`github.tsx`, which already has the viewed project's kind from `useForgeKind()`) passes one in.
 */
export function GithubLoading({ forgeKind }: { forgeKind?: ForgeKind } = {}) {
  return (
    <div data-route="github" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title={`Loading ${forgeLabel(forgeKind)}…`}
        subtitle={`Fetching open issues and ${forgePrNoun(forgeKind, { plural: true })}.`}
      />
    </div>
  )
}

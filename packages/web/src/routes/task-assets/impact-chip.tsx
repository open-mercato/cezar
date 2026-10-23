import { FileSearchIcon } from 'lucide-react'

import { useRunArtifacts } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { IMPACT_FILE, impactAssetsPath } from './impact-model'

/**
 * The **Impact** chip (spec 2026-10-22-html-artifacts-and-impact § Task list / task header): a run
 * with a `subject` whose report exists opens its Assets view directly. Only subject runs fetch the
 * listing, which the `artifacts` SSE frame then keeps live.
 */
export function ImpactChip({ run, className }: { run: Pick<ApiRun, 'id' | 'subject'>; className?: string }) {
  const listing = useRunArtifacts(run.subject ? run.id : undefined)
  if (!run.subject || !listing.data?.artifacts?.some((artifact) => artifact.name === IMPACT_FILE)) return null
  return (
    <Link
      to={impactAssetsPath(run.id)}
      data-slot="impact-chip"
      title="Open the impact report"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        className,
      )}
    >
      <FileSearchIcon aria-hidden="true" className="size-3" />
      Impact
    </Link>
  )
}

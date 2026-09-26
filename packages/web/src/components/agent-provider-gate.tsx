import type { ResolvedEngine } from '@/components/engine-pills'
import { Link } from '@/lib/project-router'

/** Explain an unavailable start and keep its recovery link in the active project. */
export function AgentProviderGate({ resolved, dataSlot }: {
  resolved: Pick<ResolvedEngine, 'providerPending' | 'providerError' | 'canRun'>
  dataSlot?: string
}) {
  if (resolved.providerPending || resolved.canRun) return null
  return (
    <span data-slot={dataSlot} className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {resolved.providerError
        ? 'Provider authentication could not be verified.'
        : 'Connect an agent provider to run this item.'}
      <Link to="/settings/agents#providers" className="font-medium text-foreground underline underline-offset-4">
        Configure providers
      </Link>
    </span>
  )
}

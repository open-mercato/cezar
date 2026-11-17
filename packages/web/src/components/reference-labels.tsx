import type { ReferenceLabel, ReferenceLabelSet } from '@open-mercato/cezar-api-client'

import { useReferenceStatus } from '@/components/reference-status'
import { labelChipStyle } from '@/routes/github/github-filter'
import { cn } from '@/lib/utils'

/** One compact label pill, in the forge's own colour (#2032). The name is always visible, so
 *  colour is never the only signal; long names truncate with the full one in `title`. */
export function ReferenceLabelPill({ label, className }: { label: ReferenceLabel; className?: string }) {
  return (
    <span
      data-slot="reference-label"
      title={label.name}
      style={labelChipStyle(label.color)}
      className={cn(
        'inline-flex h-4 max-w-[8rem] shrink-0 items-center rounded-full border px-1.5 text-meta leading-none',
        className,
      )}
    >
      <span className="truncate">{label.name}</span>
    </span>
  )
}

/** The labels a hover card lists in full, plus how many the forge has beyond what it sent. */
export function ReferenceLabelList({ labels }: { labels: ReferenceLabelSet }) {
  if (labels.items.length === 0) return null
  return (
    <span data-slot="reference-label-list" className="flex flex-wrap gap-1 pt-0.5">
      {labels.items.map((label) => (
        <ReferenceLabelPill key={label.name} label={label} />
      ))}
      {labels.more ? <span className="text-meta text-muted-foreground">+{labels.more} more</span> : null}
    </span>
  )
}

/** First `max` of a set, and how many are left over (the forge's own overflow included). */
export function capReferenceLabels(
  labels: ReferenceLabelSet | undefined,
  max: number,
): { shown: ReferenceLabel[]; hidden: number } {
  const items = labels?.items ?? []
  return { shown: items.slice(0, max), hidden: Math.max(0, items.length - max) + (labels?.more ?? 0) }
}

/**
 * The reference's labels as a short strip next to its chip: at most `max` pills and a `+N` whose
 * title names the rest. Renders nothing when no labels are known (an older server, another forge,
 * a reference without labels), so a surface can mount it unconditionally.
 */
export function ReferenceLabels({
  kind,
  number,
  projectId,
  max = 3,
  className,
}: {
  kind: 'PR' | 'Issue'
  number?: number
  projectId?: string
  max?: number
  className?: string
}) {
  const entry = useReferenceStatus(kind, number, projectId)
  const { shown, hidden } = capReferenceLabels(entry.labels, max)
  if (shown.length === 0) return null
  const rest = (entry.labels?.items ?? []).slice(max).map((label) => label.name)
  return (
    <span data-slot="reference-labels" className={cn('inline-flex min-w-0 flex-nowrap items-center gap-1', className)}>
      {shown.map((label) => (
        <ReferenceLabelPill key={label.name} label={label} />
      ))}
      {hidden > 0 ? (
        <span
          data-slot="reference-labels-more"
          title={rest.length > 0 ? rest.join(', ') : undefined}
          className="shrink-0 text-meta text-muted-foreground"
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  )
}

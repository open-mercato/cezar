import { useInfiniteQuery } from '@tanstack/react-query'
import { queryScope, type TrackerAssociation } from '@open-mercato/cezar-api-client'
import { getTrackerItems } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/chip'

/** Use scoped issue reads: Jira's global label catalog is not project-isolated. */
export function TrackerLabelSuggestions({ association, selected, onSelect, onRemove }: {
  association: TrackerAssociation
  selected: string[]
  onSelect: (label: string) => void
  onRemove: (label: string) => void
}) {
  const query = useInfiniteQuery({
    queryKey: ['tracker', queryScope(), 'label-suggestions', association],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => getTrackerItems({ association, state: 'all', limit: 50, cursor: pageParam }, { signal }),
    getNextPageParam: page => page.available && page.truncated ? page.nextCursor : undefined,
    retry: false,
    staleTime: 60_000,
  })
  const pages = query.data?.pages ?? []
  const lastPage = pages.at(-1)
  const failure = pages.find(page => !page.available)
  // Never show a partial catalog as a successful empty result after a failed page.
  const failed = query.isError || !!failure
  const labels = [...new Set([...selected, ...(failed ? [] : pages.flatMap(page => page.available ? page.items.flatMap(item => item.labels) : []))])]
    .filter(label => selected.includes(label) || (label.length > 0 && label.length <= 200))
    .sort((a, b) => a.localeCompare(b))
  return <div className="flex flex-col gap-2" aria-label="Project label suggestions">
    <span className="font-medium">Required labels</span>
    <p className="text-xs text-muted-foreground">All selected labels must match. Leave unselected to allow any label.</p>
    <div role="group" aria-label="Required labels" className="flex flex-wrap gap-1.5">
      {labels.map(label => <Chip key={label} active={selected.includes(label)} aria-pressed={selected.includes(label)} disabled={!selected.includes(label) && selected.length >= 100} onClick={() => selected.includes(label) ? onRemove(label) : onSelect(label)}>{label}</Chip>)}
    </div>
    {query.isFetching ? <p role="status">Loading labels…</p> : null}
    {failed ? <div role="alert"><p>Could not load labels. Your selection is preserved.</p><Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Retry label suggestions</Button></div> : <>
      {!query.isPending && !query.isFetching && labels.length === 0 ? <p className="text-xs text-muted-foreground">No labels found in the loaded tasks.</p> : null}
      {query.hasNextPage ? <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>Load labels from more tasks</Button> : null}
      {!query.hasNextPage && (lastPage?.available && lastPage.truncated) ? <p className="text-xs text-muted-foreground">The provider returned a limited task list.</p> : null}
    </>}
  </div>
}

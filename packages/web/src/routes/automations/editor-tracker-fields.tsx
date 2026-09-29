import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { queryScope, type TrackerTrigger } from '@open-mercato/cezar-api-client'
import { getTrackerAutomationOptions } from '@/api/client'
import { Chip } from '@/components/chip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TrackerLabelSuggestions } from './tracker-label-suggestions'
import { POLL_MINUTES } from './editor-draft'

export function EditorTrackerFields({ trigger, intervalSeconds, onChange, onValid }: {
  trigger: TrackerTrigger | undefined
  intervalSeconds: number
  onChange: (patch: { trackerTrigger?: TrackerTrigger; intervalSeconds?: number; enabled?: boolean }) => void
  onValid: (valid: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const scope = queryScope()
  // Keep connection/capability metadata independent of the changing search results.
  const metadata = useInfiniteQuery({
    queryKey: ['tracker', scope, 'automation-options', ''],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => getTrackerAutomationOptions({ ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (last) => last.available ? last.nextCursor : undefined,
    retry: false,
  })
  const options = useInfiniteQuery({
    queryKey: ['tracker', scope, 'automation-options', search],
    enabled: !!search && metadata.data?.pages[0]?.available === true,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => getTrackerAutomationOptions({ ...(search ? { search } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (last) => last.available ? last.nextCursor : undefined,
    retry: false,
  })
  const results = search ? options : metadata
  const first = metadata.data?.pages[0]
  const ready = first?.available ? first : undefined
  const sameSource = !!ready && !!trigger && JSON.stringify(ready.association) === JSON.stringify(trigger.association)
  const valid = sameSource && !!trigger?.events.length && trigger.events.every(event => ready?.events.includes(event))
    && (trigger.requiredLabels?.length ?? 0) <= 100 && (trigger.requiredLabels ?? []).every(label => label.length > 0 && label.length <= 200)
    && (!trigger.events.includes('issue.status_changed') || !!trigger.targetStatusIds?.length)
    && (!(trigger.events.includes('issue.labeled') || trigger.events.includes('issue.unlabeled')) || !!trigger.changedLabelIds?.length)
  useEffect(() => { onValid(valid); return () => onValid(false) }, [valid, onValid])
  const pages = results.data?.pages.flatMap(page => page.available ? [page] : []) ?? []
  const statuses = [...new Map(pages.flatMap(page => page.statuses).map(item => [item.id, item])).values()]
  // A saved selection can be missing because of pagination, search, or a vendor change.
  // Keep it removable without inferring that it was deleted.
  const knownStatuses = new Map((metadata.data?.pages.flatMap(page => page.available ? page.statuses : []) ?? []).map(item => [item.id, item.name]))
  const hiddenSelectedStatuses = (trigger?.targetStatusIds ?? []).filter(id => !statuses.some(item => item.id === id))
  const labels = [...new Map(pages.flatMap(page => page.labels).map(item => [item.id, item])).values()]
  const wantsStatuses = trigger?.events.includes('issue.status_changed')
  const wantsLabels = trigger?.events.some(event => event === 'issue.labeled' || event === 'issue.unlabeled')
  const searchLabel = wantsStatuses && wantsLabels ? 'Search tracker statuses and labels' : wantsLabels ? 'Search tracker labels' : 'Search tracker statuses'
  return <div data-slot="editor-tracker" className="flex flex-col gap-3 text-sm">
    {metadata.isPending ? <p>Loading tracker events…</p> : null}
    {metadata.isError || (first && !first.available) ? <div role="alert">
      <p>{first && !first.available ? first.reason : 'Could not load tracker events.'} Check the project’s Issue tracker settings.</p>
      <Button variant="outline" size="sm" onClick={() => void metadata.refetch()}>Retry</Button>
    </div> : null}
    {ready ? <>
      <p>{ready.association.kind === 'jira' ? 'Jira' : 'Linear'} · {ready.association.externalName}</p>
      {trigger && !sameSource ? <p role="alert">The tracker connection changed. Select an event again before saving.</p> : null}
      {!trigger ? <p>Select an event to complete this automation.</p> : null}
      <div role="group" aria-label="Tracker events" className="flex flex-wrap gap-1.5">
        {ready.events.map(event => <Chip key={event} active={sameSource && trigger?.events.includes(event)} aria-pressed={sameSource && trigger?.events.includes(event)} onClick={() => {
          const current = sameSource ? trigger!.events : []
          const events = current.includes(event) ? current.filter(item => item !== event) : [...current, event]
          const nextTrigger = { ...(sameSource ? trigger : {}), association: ready.association, events }
          if (event === 'issue.status_changed' && !events.includes(event)) delete nextTrigger.targetStatusIds
          onChange({ trackerTrigger: nextTrigger, ...(!sameSource ? { enabled: false } : {}) })
        }}>{event}</Chip>)}
      </div>
      {sameSource && trigger ? <TrackerLabelSuggestions key={JSON.stringify(ready.association)} association={ready.association} selected={trigger.requiredLabels ?? []} onRemove={label => onChange({ trackerTrigger: { ...trigger, requiredLabels: (trigger.requiredLabels ?? []).filter(value => value !== label) } })} onSelect={label => onChange({ trackerTrigger: { ...trigger, requiredLabels: [...new Set([...(trigger.requiredLabels ?? []), label])] } })} /> : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Integration details</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p>Label choices come from loaded tasks in this project, including closed tasks. Saved selections remain available.</p>
          {ready.limitations.map(note => <p key={note}>{note}</p>)}
        </div>
      </details>
      {trigger?.events.some(event => event !== 'issue.opened') ? <>
        <Input aria-label={searchLabel} placeholder={searchLabel} value={search} onChange={e => setSearch(e.target.value)} />
        {results.isFetching ? <p role="status">Searching…</p> : null}
        {results.isError || (results.data?.pages[0] && !results.data.pages[0].available) ? <div role="alert">Could not load search results. <Button variant="outline" size="sm" onClick={() => void results.refetch()}>Retry search</Button></div> : null}
        {!results.isFetching && results.data?.pages[0]?.available && wantsStatuses && statuses.length === 0 ? <p>No matching statuses.</p> : null}
        {!results.isFetching && results.data?.pages[0]?.available && wantsLabels && labels.length === 0 ? <p>No matching labels.</p> : null}
        {trigger.events.includes('issue.status_changed') ? <div role="group" aria-label="Target statuses" className="flex flex-wrap gap-1.5">
          {statuses.map(item => <Chip key={item.id} active={trigger.targetStatusIds?.includes(item.id)} aria-pressed={trigger.targetStatusIds?.includes(item.id)} onClick={() => {
            const ids = trigger.targetStatusIds ?? []
            onChange({ trackerTrigger: { ...trigger, targetStatusIds: ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id] } })
          }}>{item.name}</Chip>)}
          {hiddenSelectedStatuses.map(id => <Chip key={id} active aria-pressed={true} onClick={() => {
            onChange({ trackerTrigger: { ...trigger, targetStatusIds: (trigger.targetStatusIds ?? []).filter(value => value !== id) } })
          }}>{knownStatuses.get(id) ?? id} (not in current results)</Chip>)}
        </div> : null}
        {trigger.events.some(event => event === 'issue.labeled' || event === 'issue.unlabeled') ? <div role="group" aria-label="Changed labels" className="flex flex-wrap gap-1.5">
          {labels.map(item => <Chip key={item.id} active={trigger.changedLabelIds?.includes(item.id)} aria-pressed={trigger.changedLabelIds?.includes(item.id)} onClick={() => {
            const ids = trigger.changedLabelIds ?? []
            onChange({ trackerTrigger: { ...trigger, changedLabelIds: ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id] } })
          }}>{item.name}</Chip>)}
        </div> : null}
        {results.hasNextPage ? <Button variant="outline" size="sm" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>Load more</Button> : null}
      </> : null}
    </> : null}
    <div className="flex items-center gap-2">Check every
      <Select value={String(intervalSeconds / 60)} onValueChange={value => onChange({ intervalSeconds: Number(value) * 60 })}>
        <SelectTrigger aria-label="Tracker poll interval" className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>{POLL_MINUTES.map(minutes => <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <p className="text-xs text-muted-foreground">Only events after enabling are eligible. Existing backlog is not launched. The workflow agent receives this project’s tracker credentials to carry out your instructions; status updates are not guaranteed by the scheduler.</p>
  </div>
}

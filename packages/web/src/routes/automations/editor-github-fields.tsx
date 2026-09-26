import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'

import type { AutomationEvent } from '@open-mercato/cezar-api-client'
import { Chip } from '@/components/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

import { GITHUB_EVENTS, POLL_MINUTES, clamp, needsChangedLabels, type DraftFilters } from './editor-draft'

/**
 * The "When GitHub changes" half of the When section (spec 2026-09-14-automations-redesign
 * § UI/UX 4.3): the seven event chips (multi-select — the contract is `events[]`), the poll line,
 * and the shipped feature's filters under a Collapsible the export does not draw.
 */
export function EditorGithubFields({
  events,
  intervalSeconds,
  filters,
  onChange,
}: {
  events: readonly AutomationEvent[]
  intervalSeconds: number
  filters: DraftFilters
  onChange: (patch: { events?: AutomationEvent[]; intervalSeconds?: number; filters?: DraftFilters }) => void
}) {
  const hasList = (['authors', 'assignees', 'anyLabels', 'allLabels', 'excludeLabels', 'changedLabels', 'reviewers'] as const)
    .some((key) => filters[key].trim().length > 0)
  const [open, setOpen] = useState(hasList || filters.lookbackDays !== 7 || filters.maxRecords !== 25)
  const setFilter = <K extends keyof DraftFilters>(key: K, value: DraftFilters[K]) =>
    onChange({ filters: { ...filters, [key]: value } })
  const toggleEvent = (event: AutomationEvent) => {
    const next = events.includes(event) ? events.filter((item) => item !== event) : [...events, event]
    onChange({ events: GITHUB_EVENTS.filter((item) => next.includes(item)) })
  }
  const changedRequired = needsChangedLabels(events)
  const changedMissing = changedRequired && filters.changedLabels.trim().length === 0

  return (
    <div data-slot="editor-github" className="flex flex-col gap-3.5">
      <div role="group" aria-label="GitHub events" className="flex flex-wrap gap-1.5">
        {GITHUB_EVENTS.map((event) => (
          <Chip
            key={event}
            active={events.includes(event)}
            aria-pressed={events.includes(event)}
            className="font-mono"
            onClick={() => toggleEvent(event)}
          >
            {event}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        poll every
        <Select value={String(Math.round(intervalSeconds / 60))} onValueChange={(value) => onChange({ intervalSeconds: Number(value) * 60 })}>
          <SelectTrigger size="sm" aria-label="Poll interval" className="text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLL_MINUTES.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>· last {filters.lookbackDays} days · maximum {filters.maxRecords} records</span>
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon aria-hidden="true" className={cn('size-3 transition-transform', open ? '' : '-rotate-90')} />
            Filters
            {changedMissing ? <span className="text-danger">· changed labels required</span> : null}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div data-slot="editor-github-filters" className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
            <FilterField id="filter-authors" label="Authors" value={filters.authors} onChange={(value) => setFilter('authors', value)} />
            <FilterField id="filter-assignees" label="Assignees" value={filters.assignees} onChange={(value) => setFilter('assignees', value)} />
            <FilterField id="filter-any-labels" label="Any of labels" value={filters.anyLabels} onChange={(value) => setFilter('anyLabels', value)} />
            <FilterField id="filter-all-labels" label="All of labels" value={filters.allLabels} onChange={(value) => setFilter('allLabels', value)} />
            <FilterField id="filter-exclude-labels" label="Exclude labels" value={filters.excludeLabels} onChange={(value) => setFilter('excludeLabels', value)} />
            <FilterField
              id="filter-changed-labels"
              label={changedRequired ? 'Changed labels (required)' : 'Changed labels'}
              value={filters.changedLabels}
              invalid={changedMissing}
              onChange={(value) => setFilter('changedLabels', value)}
            />
            <FilterField id="filter-reviewers" label="Reviewers" value={filters.reviewers} onChange={(value) => setFilter('reviewers', value)} />
            <NumberField id="filter-lookback" label="Lookback days (1–90)" value={filters.lookbackDays} min={1} max={90} onChange={(value) => setFilter('lookbackDays', value)} />
            <NumberField id="filter-max-records" label="Max records (1–100)" value={filters.maxRecords} min={1} max={100} onChange={(value) => setFilter('maxRecords', value)} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function FilterField({ id, label, value, invalid = false, onChange }: {
  id: string
  label: string
  value: string
  invalid?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder="comma-separated"
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 text-[13px]"
      />
    </div>
  )
}

function NumberField({ id, label, value, min, max, onChange }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        className="h-8 w-28 font-mono text-[13px] tabular-nums"
      />
    </div>
  )
}

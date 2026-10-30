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

/** Each event in plain words; the id stays as the chip's accessible name and its small print. */
export const EVENT_LABELS: Record<AutomationEvent, string> = {
  'pull_request.opened': 'A pull request opens',
  'issue.opened': 'An issue opens',
  'issue.labeled': 'An issue gets a label',
  'issue.unlabeled': 'An issue loses a label',
  'pull_request.reviewed': 'A review is submitted',
  'pull_request.review_requested': 'A review is requested',
  'pull_request.rereview_requested': 'A re-review is requested',
  'pull_request.closed': 'A pull request closes',
  'pull_request.merged': 'A pull request merges',
}

/**
 * The "When GitHub changes" half of the When section (spec 2026-09-14-automations-redesign
 * § UI/UX 4.3, worded for people since spec 2026-10-26 § Automations editor): the nine events
 * as plain sentences (multi-select — the contract is `events[]`), the poll line as a sentence,
 * and the filters under a Collapsible the export does not draw.
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
  const listed = (['authors', 'assignees', 'anyLabels', 'allLabels', 'excludeLabels', 'changedLabels', 'reviewers'] as const)
    .filter((key) => filters[key].trim().length > 0)
  const [open, setOpen] = useState(listed.length > 0 || filters.lookbackDays !== 7 || filters.maxRecords !== 25)
  const setFilter = <K extends keyof DraftFilters>(key: K, value: DraftFilters[K]) =>
    onChange({ filters: { ...filters, [key]: value } })
  const toggleEvent = (event: AutomationEvent) => {
    const next = events.includes(event) ? events.filter((item) => item !== event) : [...events, event]
    onChange({ events: GITHUB_EVENTS.filter((item) => next.includes(item)) })
  }
  const changedRequired = needsChangedLabels(events)
  const changedMissing = changedRequired && filters.changedLabels.trim().length === 0

  return (
    <div data-slot="editor-github" className="flex flex-col gap-4">
      <div role="group" aria-label="GitHub events" className="flex flex-wrap gap-1.5">
        {GITHUB_EVENTS.map((event) => (
          <Chip
            key={event}
            active={events.includes(event)}
            aria-pressed={events.includes(event)}
            aria-label={event}
            title={event}
            className="h-8 gap-2 px-3"
            onClick={() => toggleEvent(event)}
          >
            {EVENT_LABELS[event]}
            <span className="font-mono text-micro font-normal text-soft-foreground">{event}</span>
          </Chip>
        ))}
      </div>
      {events.length === 0 ? <p className="m-0 text-label text-danger">Pick at least one event.</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
        Checks GitHub every
        <Select value={String(Math.round(intervalSeconds / 60))} onValueChange={(value) => onChange({ intervalSeconds: Number(value) * 60 })}>
          <SelectTrigger size="sm" aria-label="Poll interval" className="text-ui">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLL_MINUTES.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>while this cockpit is open, looking back {filters.lookbackDays} days, at most {filters.maxRecords} records.</span>
      </div>
      <p data-slot="editor-github-how" className="-mt-2 m-0 text-label text-soft-foreground">
        Through your <code className="text-xs">gh</code>. No webhook or public URL needed.
      </p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 text-ui text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon aria-hidden="true" className={cn('size-3 transition-transform', open ? '' : '-rotate-90')} />
            Filters
            {changedMissing ? (
              <span className="text-danger">· changed labels required</span>
            ) : listed.length > 0 ? (
              <span className="text-soft-foreground">· {listed.length} set</span>
            ) : (
              <span className="text-soft-foreground">· authors, labels, reviewers</span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="m-0 pt-2 text-label text-soft-foreground">
            Only matching events start a task. Names in the prompt do not narrow it down; these do.
          </p>
          <div data-slot="editor-github-filters" className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2">
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
        className="h-8 text-ui"
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
        className="h-8 w-28 font-mono text-ui tabular-nums"
      />
    </div>
  )
}

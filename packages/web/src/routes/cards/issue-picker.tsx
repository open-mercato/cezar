import type { CardIssue, GithubData, TrackerAssociation, TrackerItemsResponse } from '@open-mercato/cezar-api-client'
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react'
import * as React from 'react'

import { useGithubInfinite, useTrackerAssociation, useTrackerItems } from '@/api/queries'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { parseIssueRef } from '@/lib/cards'
import { cn } from '@/lib/utils'

/**
 * The New card dialog's "Linked issue" picker: open issues from every source the project has —
 * GitHub (when `gh`/a remote answers) and the connected tracker — searchable, with a typed-ref
 * fallback. Fetches on first open only; an unavailable source simply lists nothing.
 */

/** A picked issue: the card's `issue` plus what the dialog prefills from it. */
export type PickedIssue = CardIssue & { title?: string; body?: string }

export interface IssueOption extends PickedIssue {
  /** Group label — "GitHub", "Linear", "Jira". */
  source: string
  title: string
}

const TRACKER_LABEL: Record<TrackerAssociation['kind'], string> = { linear: 'Linear', jira: 'Jira' }

export function issueOptions(
  github: readonly GithubData[] | undefined,
  tracker: { association: TrackerAssociation; pages: readonly TrackerItemsResponse[] } | undefined,
): IssueOption[] {
  const out: IssueOption[] = []
  const seen = new Set<string>()
  const push = (option: IssueOption) => {
    const key = `${option.provider}:${option.ref}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(option)
  }
  for (const page of github ?? []) {
    if (!page.available) continue
    for (const issue of page.issues) {
      push({ provider: 'github', ref: `#${issue.number}`, url: issue.url, title: issue.title, ...(issue.body ? { body: issue.body } : {}), source: 'GitHub' })
    }
  }
  if (tracker) {
    for (const page of tracker.pages) {
      if (!page.available) continue
      for (const item of page.items) {
        push({ provider: tracker.association.kind, ref: item.id, url: item.url, title: item.title, ...(item.body ? { body: item.body } : {}), source: TRACKER_LABEL[tracker.association.kind] })
      }
    }
  }
  return out
}

/** Every whitespace-separated token must appear in the ref or the title (case-insensitive). */
export function filterIssueOptions(options: readonly IssueOption[], query: string): IssueOption[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [...options]
  return options.filter((option) => {
    const hay = `${option.ref} ${option.ref.replace(/^#/, '')} ${option.title}`.toLowerCase()
    return tokens.every((token) => hay.includes(token))
  })
}

function sameRef(a: string, b: string): boolean {
  return a.replace(/^#/, '').toLowerCase() === b.replace(/^#/, '').toLowerCase()
}

export function IssuePicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: PickedIssue | null
  onChange: (issue: PickedIssue | null) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  // Nothing is fetched until the picker first opens; after that the cache serves re-opens.
  const [armed, setArmed] = React.useState(false)
  const github = useGithubInfinite(50, armed)
  const association = useTrackerAssociation(armed)
  const linked = association.data?.association ?? null
  const trackerItems = useTrackerItems(linked, { state: 'active', labels: NO_LABELS, query: '' }, armed)

  const options = issueOptions(
    github.isError ? undefined : github.data?.pages,
    linked && !trackerItems.isError && trackerItems.data ? { association: linked, pages: trackerItems.data.pages } : undefined,
  )
  const matched = filterIssueOptions(options, query)
  const groups = [...new Set(matched.map((o) => o.source))]
  const loading = armed && (github.isPending || association.isPending || (linked != null && trackerItems.isPending))
  const typed = query.trim()
  const manual = typed && !options.some((o) => sameRef(o.ref, typed)) ? parseIssueRef(typed) : undefined
  const manualIssue = manual ? { ...manual, provider: manual.provider === 'tracker' && linked ? linked.kind : manual.provider } : undefined

  const pick = (issue: PickedIssue) => {
    onChange(issue)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="flex items-center gap-1.5">
      <Popover
        modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) setArmed(true)
          else setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            data-slot="issue-picker-trigger"
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-3 text-left text-ui outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
              open && 'border-violet ring-[3px] ring-violet/25',
            )}
          >
            {value ? (
              <>
                <span className="shrink-0 font-mono text-label font-semibold text-foreground">{value.ref}</span>
                <span className="min-w-0 truncate text-label text-muted-foreground">{value.title ?? ''}</span>
              </>
            ) : (
              <span className="text-label text-soft-foreground">None — pick an issue</span>
            )}
            <ChevronDownIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-soft-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} data-slot="issue-picker" className="w-[min(26rem,calc(100vw-2rem))] p-0">
          <Command label="Link an issue" shouldFilter={false} loop>
            <CommandInput placeholder="Search issues, or type #42 / LIN-412…" value={query} onValueChange={setQuery} />
            <CommandList label="Open issues" className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]">
              {loading ? (
                <div data-slot="issue-picker-loading" className="flex items-center gap-2 px-3 py-2 text-label text-muted-foreground">
                  <Spinner className="size-3.5" /> Loading issues…
                </div>
              ) : null}
              {!loading && matched.length === 0 && !manualIssue ? (
                <CommandEmpty>{options.length === 0 ? 'No open issues to list — type a ref like #42 or LIN-412.' : 'No issue matches.'}</CommandEmpty>
              ) : null}
              {manualIssue ? (
                <CommandGroup>
                  <CommandItem value={`manual ${manualIssue.ref}`} data-slot="issue-picker-manual" onSelect={() => pick(manualIssue)}>
                    Use “{manualIssue.ref}”
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {groups.map((source) => (
                <CommandGroup key={source} heading={source}>
                  {matched
                    .filter((o) => o.source === source)
                    .map((option) => {
                      const selected = value != null && value.provider === option.provider && value.ref === option.ref
                      return (
                        <CommandItem
                          key={`${option.provider}:${option.ref}`}
                          value={`${option.provider}:${option.ref}`}
                          data-slot="issue-picker-option"
                          data-issue={option.ref}
                          onSelect={() => pick({ provider: option.provider, ref: option.ref, url: option.url, title: option.title, ...(option.body ? { body: option.body } : {}) })}
                        >
                          <span className="shrink-0 font-mono text-xs">{option.ref}</span>
                          <span className="min-w-0 flex-1 truncate text-label">{option.title}</span>
                          <span className="shrink-0 text-micro text-soft-foreground">{option.source}</span>
                          {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
                        </CommandItem>
                      )
                    })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value ? (
        <button
          type="button"
          aria-label="Clear linked issue"
          onClick={() => onChange(null)}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

const NO_LABELS: readonly string[] = []

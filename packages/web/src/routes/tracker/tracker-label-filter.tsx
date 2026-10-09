import { CheckIcon, TagIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Loaded labels are suggestions, not a complete vendor catalogue; arbitrary labels stay usable. */
export function TrackerLabelFilter({ options, selected, onChange }: {
  options: readonly string[]; selected: readonly string[]; onChange: (labels: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const labels = [...new Set([...selected, ...options])].sort()
  const toggle = (label: string) => onChange(selected.includes(label) ? selected.filter(value => value !== label) : [...selected, label])
  const custom = query.trim()
  return <Popover onOpenChange={open => { if (!open) setQuery('') }}>
    <PopoverTrigger asChild><Button variant="outline" size="sm" aria-label="Filter labels" className={cn('shrink-0 px-2 font-normal text-muted-foreground', selected.length > 0 && 'text-foreground')}><TagIcon aria-hidden="true" />Labels{selected.length ? <Badge variant="secondary" className="px-1.5 py-0 tabular-nums">{selected.length}</Badge> : null}</Button></PopoverTrigger>
    <PopoverContent align="end" sideOffset={6} className="w-60 p-0">
      <Command label="Find or add label" shouldFilter={false}>
        <CommandInput aria-label="Find or add label" placeholder="Find or add label…" value={query} onValueChange={setQuery} maxLength={256} />
        <CommandList className="max-h-64">
          {selected.length ? <CommandItem onSelect={() => onChange([])}>Clear filters</CommandItem> : null}
          {labels.filter(label => label.toLowerCase().includes(custom.toLowerCase())).map(label => <CommandItem key={label} value={label} disabled={!selected.includes(label) && selected.length >= 20} onSelect={() => toggle(label)}><span className="min-w-0 flex-1 truncate">{label}</span>{selected.includes(label) ? <CheckIcon className="size-3.5 text-primary-strong" /> : null}</CommandItem>)}
          {custom && !labels.includes(custom) ? <CommandItem disabled={selected.length >= 20} onSelect={() => { toggle(custom); setQuery('') }}>Use label “{custom}”</CommandItem> : null}
          <p className="px-3 py-2 text-xs text-muted-foreground">Suggestions come from loaded issues. Type any exact label to filter.</p>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}

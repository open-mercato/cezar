import { BotIcon, MessageCircleIcon, QuoteIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FocusEvent } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MessageQuote } from './types'

export function QuoteChips({ quotes, onEdit, onRemove }: { quotes: readonly MessageQuote[]; onEdit: (quote: MessageQuote) => void; onRemove: (id: string) => void }) {
  if (!quotes.length) return null
  return <div data-slot="quote-chips" className="flex flex-wrap gap-1.5">{quotes.map((quote) => <QuoteChip key={quote.id} quote={quote} onEdit={onEdit} onRemove={onRemove} />)}</div>
}

// A tooltip names, it does not hold a page: past this the editor shows the whole excerpt.
const TOOLTIP_EXCERPT_MAX = 240
export function tooltipText(excerpt: string): string {
  return excerpt.length > TOOLTIP_EXCERPT_MAX ? `${excerpt.slice(0, TOOLTIP_EXCERPT_MAX).trimEnd()}… (click to read it all)` : excerpt
}

function QuoteChip({ quote, onEdit, onRemove }: { quote: MessageQuote; onEdit: (quote: MessageQuote) => void; onRemove: (id: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(quote.body)
  // Closing the editor unmounts the focused input; hand focus back to the chip, not to BODY.
  const chipButton = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    chipButton.current?.focus()
  }, [editing])
  // Set once Enter, Save or Escape closed the editor, so the blur that follows changes nothing.
  const closed = useRef(false)
  const open = () => { closed.current = false; setBody(quote.body); setEditing(true) }
  const close = () => { closed.current = true; refocus.current = true; setEditing(false) }
  const save = () => { onEdit({ ...quote, body }); close() }
  const cancel = () => { setBody(quote.body); close() }
  // Focus left for the composer or Send: keep the note rather than drop it unsaved.
  const commitOnLeave = (event: FocusEvent<HTMLElement>) => {
    if (closed.current || event.currentTarget.contains(event.relatedTarget as Node | null)) return
    closed.current = true
    if (body !== quote.body) onEdit({ ...quote, body })
    setEditing(false)
  }
  const RoleIcon = quote.role === 'assistant' ? BotIcon : QuoteIcon
  // Names the chip, so a screen reader tells twelve Remove buttons apart (as diff-comment chips do).
  const label = quote.excerpt.slice(0, 60)
  if (editing) {
    return (
      <span data-slot="quote-chip-editor" onBlur={commitOnLeave} className="flex max-w-full flex-col gap-1 rounded-md border border-border bg-muted/40 p-1.5 text-xs">
        {/* The one place the whole excerpt is readable before it is sent (the chip shows 60 chars). */}
        <span data-slot="quote-chip-excerpt" className="max-h-40 max-w-[min(300px,calc(100vw-4rem))] overflow-y-auto wrap-anywhere whitespace-pre-wrap text-muted-foreground italic">{quote.excerpt}</span>
        <span className="flex items-center gap-1">
          <input
            autoFocus
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Note on quote"
            placeholder="Add a note"
            className="h-7 min-w-32 flex-1 bg-transparent px-1 outline-none"
            onKeyDown={(event) => {
              // The composer must not send on this Enter, nor close on this Escape.
              if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); save() }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
            }}
          />
          <button type="button" aria-label="Save quote note" className="rounded px-1.5 py-1 font-medium hover:bg-muted" onClick={save}>Save</button>
        </span>
      </span>
    )
  }
  return (
    <span data-slot="quote-chip" className="flex max-w-[300px] items-center rounded-md border border-border bg-muted/40 text-xs">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button ref={chipButton} type="button" aria-label={`Edit note on quote: ${label}${quote.body ? ' (has a note)' : ''}`} onClick={open} className="flex min-w-0 items-center gap-1.5 truncate px-2 py-1.5 text-left hover:bg-muted pointer-coarse:min-h-11">
              <RoleIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{quote.excerpt.slice(0, 60)}</span>
              {quote.body ? <MessageCircleIcon className="size-3 shrink-0" aria-hidden="true" /> : null}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{tooltipText(quote.excerpt)}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <button type="button" aria-label={`Remove quote: ${label}`} onClick={() => onRemove(quote.id)} className="px-1.5 py-1.5 text-soft-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:inline-flex pointer-coarse:items-center pointer-coarse:justify-center"><XIcon className="size-3.5" /></button>
    </span>
  )
}

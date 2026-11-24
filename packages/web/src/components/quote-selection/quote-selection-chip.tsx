import { QuoteIcon } from 'lucide-react'
import { QUOTE_ACTION_ATTR, retireCapture, type QuoteCapture } from './types'

/** The composer's "Quote selection" chip on touch (spec 2026-11-20, § 1, owner decision 1). */
export function QuoteSelectionChip({ capture, onQuote }: { capture: QuoteCapture; onQuote: (capture: QuoteCapture) => void }) {
  return (
    <button
      type="button"
      data-slot="quote-selection-chip"
      {...{ [QUOTE_ACTION_ATTR]: '' }}
      title={capture.excerpt.slice(0, 200)}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        retireCapture(capture)
        onQuote(capture)
      }}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-dashed border-border bg-muted/40 px-3 text-xs font-medium hover:bg-muted"
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />Quote selection
    </button>
  )
}

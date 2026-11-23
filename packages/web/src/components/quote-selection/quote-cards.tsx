import { CornerUpLeftIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MessageQuote } from './types'

// A quote with a `#n` can be found again; one without (an old recording) cannot.
const hasRef = (quote: MessageQuote) => quote.ref !== undefined

function sourceLabel(quote: MessageQuote, taskDescription: boolean): string {
  if (taskDescription && quote.role === 'user' && quote.ref === 0) return 'From the task description'
  if (taskDescription && quote.role === 'assistant' && quote.ref === 0) return 'From the reply to the task'
  const label = quote.role === 'assistant' ? 'From assistant message' : 'From your earlier message'
  return quote.ref === undefined ? label : `${label} #${quote.ref}`
}

export function QuoteCards({ quotes, onJump, canJump = hasRef, taskDescription = false, className }: {
  quotes: readonly MessageQuote[]
  onJump?: (quote: MessageQuote) => void
  /** Whether the host can resolve this quote's source; by default, any quote with a `#n`. */
  canJump?: (quote: MessageQuote) => boolean
  /** Task thread only: ref 0 is the task's prompt (user) or the reply to it (assistant). The
   *  manager chat's seq 0 is an ordinary message. */
  taskDescription?: boolean
  className?: string
}) {
  if (!quotes.length) return null
  return (
    <section data-slot="quote-cards" aria-label="Quoted messages" className={cn('my-2 flex flex-col gap-2', className)}>
      {quotes.map((quote) => {
        const label = sourceLabel(quote, taskDescription)
        return (
          <article key={quote.id} data-slot="quote-card" className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="min-w-0">{label}</span>
              {onJump && canJump(quote) ? (
                <button type="button" aria-label={`Jump to message: ${label}`} onClick={() => onJump(quote)} className="inline-flex shrink-0 items-center gap-1 font-medium whitespace-nowrap text-foreground hover:underline pointer-coarse:min-h-11">
                  <CornerUpLeftIcon aria-hidden="true" className="size-3.5" />Jump to message
                </button>
              ) : null}
            </div>
            <div className={quote.code ? 'mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-xs' : 'mt-1 border-l-2 border-border pl-2 text-sm whitespace-pre-wrap italic'}>{quote.excerpt}</div>
            {quote.body ? <p className="mt-2 whitespace-pre-wrap text-sm">{quote.body}</p> : null}
          </article>
        )
      })}
    </section>
  )
}

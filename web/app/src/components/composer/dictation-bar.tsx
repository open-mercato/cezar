import { ArrowUpIcon, CheckIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useNow } from '@/lib/use-now'
import { formatElapsed } from './dictation'

/**
 * The recording overlay (paseo `DictationOverlay`): swaps in for the footer bar — pulsing
 * indicator, mm:ss, the growing partial transcript, then ✕ cancel / ✓ insert / ↑ insert-and-send.
 */
export function DictationBar({
  transcript,
  startedAt,
  onCancel,
  onInsert,
  onInsertAndSend,
}: {
  transcript: string
  startedAt: number
  onCancel: () => void
  onInsert: () => void
  onInsertAndSend: () => void
}) {
  const now = useNow(1000)
  return (
    <div
      data-slot="dictation-overlay"
      role="status"
      aria-label="Dictation in progress"
      className="flex items-center gap-2.5 rounded-b-xl border-t border-border bg-muted/60 px-3 py-2"
    >
      <span
        aria-hidden="true"
        className="size-2 flex-none animate-pulse rounded-full bg-danger motion-reduce:animate-none"
      />
      <span data-slot="dictation-timer" className="text-xs font-medium text-muted-foreground tabular-nums">
        {formatElapsed(startedAt, now)}
      </span>
      <span
        data-slot="dictation-transcript"
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-sm text-foreground"
      >
        {transcript === '' ? (
          <span className="text-muted-foreground">Listening…</span>
        ) : (
          transcript
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-round"
        aria-label="Cancel dictation"
        className="text-muted-foreground"
        onClick={onCancel}
      >
        <XIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-round"
        aria-label="Insert transcription"
        onClick={onInsert}
      >
        <CheckIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-round"
        aria-label="Insert transcription and send"
        onClick={onInsertAndSend}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
    </div>
  )
}

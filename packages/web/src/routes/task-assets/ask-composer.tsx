import { AtSignIcon, LoaderCircleIcon, SendIcon, XIcon } from 'lucide-react'
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

import { useActiveProviderAvailability } from '../task-thread/active-provider'
import { useDeliverPrompt } from '../task-thread/deliver-prompt'
import { useContinueAction } from '../task-thread/follow-up-engine'
import { askMessage, type ArtifactReference } from './artifact-bridge'

/**
 * The composer docked under the Assets frame (spec 2026-10-22-html-artifacts-and-impact, R4). It
 * delivers through the chat composer's own seam — `useDeliverPrompt` with the thread's Continue —
 * so a live run takes `POST /messages` and a closed one is Continued exactly as the chat does.
 * A reference chip only labels the message; nothing leaves until the user presses Send.
 */
export function AssetsAskComposer({
  run,
  reference,
  onClearReference,
}: {
  run: ApiRun
  reference: ArtifactReference | null
  onClearReference: () => void
}) {
  const continueAction = useContinueAction(run)
  const deliver = useDeliverPrompt(run, continueAction.continueWith)
  const activeProvider = useActiveProviderAvailability(run)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonId = useId()

  // The chat composer's own condition (task-composer.tsx): a live session, a queued prompt, or a
  // closed run whose session can be reopened. Anything else cannot receive a message at all.
  const sessionOpen = run.status === 'running' || run.status === 'waiting'
  const queued = run.status === 'queued'
  const hasContinuation = !sessionOpen && !queued && continueAction.available
  if (!sessionOpen && !queued && !hasContinuation) return null
  if (run.worktreeLifecycle?.activeOperationId) return null

  const blockedReason =
    sessionOpen && !activeProvider.usable ? activeProvider.reason
    : hasContinuation && !continueAction.canContinue ? (continueAction.reason ?? 'No provider can continue this task.')
    : undefined
  const canSend = !blockedReason && !sending && text.trim() !== ''

  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      await deliver(askMessage(reference, text.trim()), [])
      setText('')
      onClearReference()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send()
  }

  return (
    <form
      data-slot="assets-ask"
      aria-label="Ask about this asset"
      onSubmit={(event) => void send(event)}
      className="shrink-0 border-t border-border bg-background px-2 py-2 sm:px-3"
    >
      {reference ? (
        <span
          data-slot="assets-ask-ref"
          className="mb-1.5 inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted py-0.5 pr-0.5 pl-2 text-[11.5px]"
        >
          <AtSignIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate" title={`${reference.ref} — ${reference.label}`}>
            <span className="font-mono text-muted-foreground">{reference.ref}</span> {reference.label}
          </span>
          <button
            type="button"
            data-action="assets-ask-ref-remove"
            aria-label="Remove reference"
            onClick={onClearReference}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </button>
        </span>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          data-slot="assets-ask-input"
          aria-label={reference ? `Ask about ${reference.label || reference.ref}` : 'Ask the agent about this asset'}
          aria-describedby={blockedReason || error ? reasonId : undefined}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={Boolean(blockedReason)}
          placeholder={reference ? 'Ask or correct — ⌘↵ to send' : 'Ask the agent about this report — click an element to reference it'}
          className="max-h-32 min-h-9 flex-1 resize-y rounded-md border border-border bg-card px-2.5 py-2 text-[13px] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
        />
        <Button type="submit" size="sm" data-action="assets-ask-send" disabled={!canSend} aria-busy={sending || undefined}>
          {sending ? (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <SendIcon aria-hidden="true" />
          )}
          {hasContinuation ? 'Continue' : 'Send'}
        </Button>
      </div>
      {blockedReason || error ? (
        <p id={reasonId} data-slot="assets-ask-reason" className="mt-1 text-xs text-soft-foreground">
          {error ?? blockedReason}
        </p>
      ) : null}
    </form>
  )
}

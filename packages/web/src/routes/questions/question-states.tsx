import { CircleAlertIcon, CircleSlashIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'
import type { QuestionClosed } from '@open-mercato/cezar-api-client'

/**
 * The two card states the Questions inbox adds to every chat (spec 2026-11-17-questions-inbox,
 * design § 03): a closed card as one quiet line, and the amber "may be out of date" note.
 */

type Asker = 'manager' | 'agent'

/** "Closed: replaced", as text: reasons are never colour alone (design § E). */
export function closedHeadline(closed: Pick<QuestionClosed, 'reason' | 'answeredIn'>, asker: Asker): string {
  switch (closed.reason) {
    case 'answered':
      if (closed.answeredIn?.startsWith('task:')) return 'Answered in the task'
      if (closed.answeredIn?.startsWith('manager:')) return 'Answered in the manager’s chat'
      return 'Answered'
    case 'dismissed': return 'Closed: dismissed by you'
    case 'replaced': return 'Closed: replaced'
    case 'retracted': return `Closed: withdrawn by the ${asker}`
    case 'expired': return 'Closed: expired'
    case 'ended': return 'Closed: task ended'
  }
}

export function QuietClosedAsk({ closed, questions, asker, id, link, className }: {
  closed: Pick<QuestionClosed, 'reason' | 'detail' | 'answer' | 'answeredIn'> & { at?: string | undefined }
  questions: readonly { header: string; question: string }[]
  asker: Asker
  /** The `#decision-<id>` anchor a "Go to the newer question" link from another card lands on. */
  id?: string
  /** "Go to the newer question", "Open task". */
  link?: ReactNode
  className?: string
}) {
  const age = closed.at ? shortAge(closed.at) : ''
  const detail = closed.detail
    ?? (closed.reason === 'replaced' ? `A newer “${questions[0]?.header ?? 'question'}” question replaced this one.`
      : closed.reason === 'dismissed' && asker === 'manager' ? 'The manager was told you skipped it.'
      : undefined)
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      data-slot="ask-closed"
      data-reason={closed.reason}
      className={['flex max-w-full flex-col gap-1 rounded-lg border border-dashed border-border px-3 py-2 text-label text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className].filter(Boolean).join(' ')}
    >
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <CircleSlashIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span data-slot="ask-closed-reason" className="font-medium text-soft-foreground">{closedHeadline(closed, asker)}</span>
        {age ? <span aria-hidden="true">· {age} ago</span> : null}
        {questions.map((question, index) => <span key={index} className="rounded bg-muted px-1.5 py-px text-micro font-semibold">{question.header}</span>)}
      </span>
      {questions.map((question, index) => <s key={index} className="break-words">{question.question}</s>)}
      {closed.reason === 'answered' && closed.answer ? <span data-slot="ask-closed-answer" className="break-words text-foreground">{closed.answer}</span> : null}
      {detail || link ? (
        <span className="flex flex-wrap items-baseline gap-x-2">
          {detail ? <span className="break-words">{detail}</span> : null}
          {link}
        </span>
      ) : null}
    </div>
  )
}

/** The card stays open and counted; the note says why it may no longer need an answer. */
export function StaleNote({ detail, onDismiss, disabled }: { detail: string; onDismiss: () => void; disabled?: boolean | undefined }) {
  return (
    <div data-slot="question-stale" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-pending/40 bg-pending/10 px-2.5 py-1.5 text-label text-foreground">
      <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-pending-strong" />
      <span className="min-w-0 flex-1">May be out of date: {detail}</span>
      <Button variant="ghost" size="sm" data-slot="question-stale-dismiss" className="pointer-coarse:min-h-11" disabled={disabled} onClick={onDismiss}>Dismiss as out of date</Button>
    </div>
  )
}

/** A dismissal inside its undo window, drawn where the card was. */
export function DismissingNote({ label, onUndo }: { label: string; onUndo: () => void }) {
  return (
    <div data-slot="question-dismissing" className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-label text-muted-foreground">
      <span className="min-w-0 flex-1">Dismissed «{label}»</span>
      <Button variant="outline" size="sm" data-slot="question-undo" className="pointer-coarse:min-h-11" onClick={onUndo}>Undo</Button>
    </div>
  )
}

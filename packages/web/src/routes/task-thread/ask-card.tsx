import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { useAskAnswer } from './ask-answer'
import {
  type AskQuestionAnswer,
  type AskSelections,
  forgetAskSelections,
  readAskSelections,
  writeAskSelections,
} from './ask-selections'
import type { ThreadAsk } from './thread-state'
import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

/** What "Need more info" sends; the CEZ:ASK instructions (`handoff.ts`) tell the agent to
 *  explain the question and ask it again. */
export const ASK_MORE_INFO_ANSWER =
  'I need more information to answer this — please explain the context and ask again.'

const EMPTY_ANSWER: AskQuestionAnswer = { labels: [] }

/** The user's own text on one line: the answer is read back per `Header:` line (Codex parses
 *  it that way too), so a newline would cut it short. */
const ownText = (answer: AskQuestionAnswer) => answer.other?.trim().replace(/\s+/g, ' ') ?? ''

const isAnswered = (answer: AskQuestionAnswer) =>
  answer.moreInfo === true || answer.labels.length > 0 || ownText(answer) !== ''

/** Format one answered question the way the agent reads it back. */
function formatAnswer(question: UiAskQuestion, answer: AskQuestionAnswer): string {
  if (answer.moreInfo) return `${question.header}: ${ASK_MORE_INFO_ANSWER}`
  const own = ownText(answer)
  return `${question.header}: ${[...answer.labels, ...(own ? [own] : [])].join(', ')}`
}

/**
 * The AskUser card (#473): the agent asked one or more structured multiple-choice
 * questions via `CEZ:ASK`; render each with clickable option chips. A single
 * single-select question resolves on one tap; any other shape (multiple
 * questions, or a multi-select question) collects every answer and resolves on
 * one **Send** that posts a single combined message — the reducer resolves the
 * whole card on that one user message, so partial answers can never leak. Either
 * way the answer rides `useAskAnswer`, which picks the seam the run's state
 * allows: the live reply while the engine owns a session, and a resume once it
 * has closed — a question outlives its session, so answering one that the agent
 * asked before an idle timeout or a restart reopens the session with the answer
 * as its opening prompt. Every question also offers the user's own text ("Other…") and
 * "Need more info", which asks the agent for context instead of answering; the composer
 * below stays available for a reply to the whole card. Once resolved, the card collapses
 * to a compact summary.
 */
export function AskCard({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
  // Answered — by Send or by a free-form reply in the composer — so the held picks are spent.
  useEffect(() => {
    if (ask.resolved) forgetAskSelections(run.id, ask)
  }, [ask, run.id])
  // An answered card is a static summary — split so the delivery hook (two mutations and a
  // provider-status subscription) only mounts for a question that can still be answered.
  // Threads accumulate asks; every resolved one would otherwise carry live machinery for a
  // question nobody can answer again.
  if (ask.resolved) {
    return (
      <div
        data-slot="ask-card"
        data-resolved="true"
        className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground"
      >
        <span className="text-soft-foreground">Answered</span>
        {ask.answer ? (
          <span className="ml-1.5 break-words whitespace-pre-line text-foreground">{ask.answer}</span>
        ) : null}
      </div>
    )
  }
  return <PendingAsk ask={ask} run={run} />
}

/** The unanswered card: option chips wired to whichever delivery seam the run's state allows. */
function PendingAsk({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
  const delivery = useAskAnswer(run)
  const blocked = delivery.blockedBy !== undefined
  const questions = ask.questions
  // One-tap only when there is a single single-select question; every other
  // shape needs a combined Send so no question's answer is dropped.
  const oneTap = questions.length === 1 && questions[0]?.multiSelect !== true
  // Seeded from, and mirrored into, the store outside the card: the thread unmounts this row
  // whenever it scrolls out of a virtualized viewport, and the picks must outlive that (#1247).
  const [selections, setSelections] = useState<AskSelections>(() => readAskSelections(run.id, ask))

  const setQuestion = (index: number, answer: AskQuestionAnswer) =>
    setSelections((prev) => {
      const next = { ...prev, [index]: answer }
      writeAskSelections(run.id, ask, next)
      return next
    })

  const answerOf = (index: number) => selections[index] ?? EMPTY_ANSWER
  const answered = (index: number) => isAnswered(answerOf(index))
  const allAnswered = questions.every((_, index) => answered(index))
  // Named only once the user has started answering: a fresh card listing every header would be
  // noise, but a half-answered one is exactly where a missed question hides off-screen.
  const unanswered = questions.some((_, index) => answered(index))
    ? questions.filter((_, index) => !answered(index)).map((q) => q.header)
    : []

  const sendAll = () =>
    void delivery.send(
      questions.map((q, index) => formatAnswer(q, answerOf(index))).join('\n'),
    )

  // The session ended before the question was answered — say so, because sending the
  // answer now does more than reply: it reopens the agent's session to deliver it.
  const resuming = delivery.mode === 'resume'

  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      data-delivery={delivery.mode}
      className="rounded-lg border border-primary/25 bg-primary/[0.04] px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-xs font-medium text-primary">
          {ask.fromWorkflow ? 'The workflow is asking' : 'The agent is asking'}
        </span>
      </div>
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <AskQuestionBlock
            key={question.id ?? index}
            question={question}
            disabled={delivery.isPending || blocked}
            oneTap={oneTap}
            answer={answerOf(index)}
            onChange={(answer) => {
              if (!blocked) setQuestion(index, answer)
            }}
            onSubmit={(answer) => {
              if (!blocked && isAnswered(answer)) void delivery.send(formatAnswer(question, answer))
            }}
          />
        ))}
      </div>
      {oneTap ? (
        resuming ? (
          <p data-slot="ask-resume-hint" className="mt-3 text-[11.5px] text-soft-foreground">
            The session has ended — your answer reopens it and goes to the agent.
          </p>
        ) : null
      ) : (
        <div className="mt-3 flex items-center gap-2.5">
          <Button size="sm" disabled={delivery.isPending || blocked || !allAnswered} onClick={sendAll}>
            {resuming ? 'Send answer & reopen' : 'Send answer'}
          </Button>
          {/* The slot names the resume state, so a selector for it can never match the ordinary
              "pick one or more" hint a live run shows. */}
          <span
            data-slot={resuming ? 'ask-resume-hint' : 'ask-hint'}
            className="text-[11.5px] text-soft-foreground"
          >
            {resuming
              ? 'the session has ended — sending reopens it'
              : `${questions.length > 1 ? 'answer each question' : 'pick one or more'} — or type a reply below`}
          </span>
        </div>
      )}
      {/* Send stays disabled until every question has a pick; say which ones lack it, since a
          long card scrolls its earlier questions out of sight (#1247). */}
      {!oneTap && unanswered.length > 0 ? (
        <p data-slot="ask-unanswered" className="mt-2 text-[11.5px] text-soft-foreground">
          unanswered: {unanswered.join(', ')}
        </p>
      ) : null}
      {delivery.blockedBy === 'provider' ? (
        <div data-slot="ask-provider-gate" className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{delivery.reason}</span>
          <Link to="/settings/agents#providers" className="font-medium text-foreground underline underline-offset-4">
            Configure providers
          </Link>
        </div>
      ) : null}
      {delivery.blockedBy === 'no-session' ? (
        <p data-slot="ask-no-session" className="mt-3 text-xs text-muted-foreground">
          {delivery.reason}
        </p>
      ) : null}
      {/* A dropped answer used to be silent — the tap did nothing and said nothing. */}
      {delivery.error ? (
        <p data-slot="ask-error" role="alert" className="mt-3 text-xs text-danger">
          {delivery.error}
        </p>
      ) : null}
    </div>
  )
}

function AskQuestionBlock({
  question,
  disabled,
  oneTap,
  answer,
  onChange,
  onSubmit,
}: {
  question: UiAskQuestion
  disabled: boolean
  /** The card's only question, single-select: a final pick sends at once. */
  oneTap: boolean
  answer: AskQuestionAnswer
  onChange: (answer: AskQuestionAnswer) => void
  onSubmit: (answer: AskQuestionAnswer) => void
}) {
  const multiSelect = question.multiSelect === true
  const otherOpen = answer.other !== undefined
  const otherInput = useRef<HTMLTextAreaElement>(null)
  // Focus only on the click that opens the field — never `autoFocus`, which would also fire
  // when a virtualized row remounts on scroll and yank the viewport to it.
  const [focusOther, setFocusOther] = useState(false)
  useEffect(() => {
    if (!focusOther) return
    otherInput.current?.focus()
    setFocusOther(false)
  }, [focusOther])
  // A pick that settles the question: sent at once on a one-tap card, held otherwise.
  const settle = (next: AskQuestionAnswer) => (oneTap ? onSubmit(next) : onChange(next))

  const pick = (label: string) => {
    if (!multiSelect) {
      settle({ labels: [label] })
      return
    }
    const labels = answer.labels.includes(label)
      ? answer.labels.filter((l) => l !== label)
      : [...answer.labels, label]
    onChange({ labels, ...(otherOpen ? { other: answer.other } : {}) })
  }

  // Own text sits beside the picked options on a multi-select question, and replaces them on
  // a single-select one.
  const toggleOther = () => {
    if (otherOpen) {
      onChange({ labels: answer.labels })
      return
    }
    onChange({ labels: multiSelect ? answer.labels : [], other: '' })
    setFocusOther(true)
  }

  const toggleMoreInfo = () => (answer.moreInfo ? onChange(EMPTY_ANSWER) : settle({ labels: [], moreInfo: true }))

  return (
    <div role="group" aria-label={question.question}>
      <div className="mb-0.5 flex items-center gap-2">
        <span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
          {question.header}
        </span>
        {multiSelect ? (
          <span className="ml-auto text-[10.5px] text-soft-foreground">select all that apply</span>
        ) : null}
      </div>
      <p className="mb-2.5 break-words text-sm font-semibold text-foreground">{question.question}</p>
      <div className="flex flex-col gap-2">
        {question.options.map((option) => (
          <AskChoice
            key={option.label}
            label={option.label}
            description={option.description}
            checkbox={multiSelect}
            selected={answer.labels.includes(option.label)}
            disabled={disabled}
            onClick={() => pick(option.label)}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          <AskExtraChoice slot="ask-other" selected={otherOpen} disabled={disabled} onClick={toggleOther}>
            Other…
          </AskExtraChoice>
          <AskExtraChoice
            slot="ask-more-info"
            selected={answer.moreInfo === true}
            disabled={disabled}
            onClick={toggleMoreInfo}
          >
            Need more info
          </AskExtraChoice>
        </div>
        {otherOpen ? (
          <div data-slot="ask-other-input" className="flex flex-col gap-2">
            <Textarea
              ref={otherInput}
              rows={2}
              aria-label={`Your own answer: ${question.question}`}
              placeholder="Type your own answer"
              value={answer.other}
              disabled={disabled}
              onChange={(event) => onChange({ ...answer, other: event.target.value })}
              onKeyDown={(event) => {
                if (oneTap && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  onSubmit(answer)
                }
              }}
            />
            {oneTap ? (
              <div>
                <Button size="sm" disabled={disabled || !isAnswered(answer)} onClick={() => onSubmit(answer)}>
                  Send answer
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AskChoice({
  label,
  description,
  checkbox,
  selected,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  checkbox: boolean
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-md border px-3.5 py-2.5 text-left transition-colors',
        'hover:border-primary/50 hover:bg-primary/[0.06] disabled:pointer-events-none disabled:opacity-50',
        selected ? 'border-primary/60 bg-primary/[0.06]' : 'border-border bg-card',
      )}
    >
      <span className="flex min-w-0 items-start gap-2 text-[13.5px] font-semibold text-foreground">
        {checkbox ? (
          <span
            aria-hidden
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded border text-[10px]',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-soft-foreground',
            )}
          >
            {selected ? '✓' : ''}
          </span>
        ) : null}
        <span className="min-w-0 break-words">{label}</span>
      </span>
      {description ? (
        <span className="min-w-0 break-words text-xs text-muted-foreground">{description}</span>
      ) : null}
    </button>
  )
}

/** The two answers cezar adds to every question — smaller than the agent's own options. */
function AskExtraChoice({
  slot,
  selected,
  disabled,
  onClick,
  children,
}: {
  slot: string
  selected: boolean
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-slot={slot}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-md border border-dashed px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
        'hover:border-primary/50 hover:bg-primary/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        selected ? 'border-primary/60 bg-primary/[0.06] text-foreground' : 'border-border bg-card',
      )}
    >
      {children}
    </button>
  )
}

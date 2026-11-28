import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon } from 'lucide-react'
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react'

import { questionKey, type ApiRun } from '@open-mercato/cezar-api-client'
import { scheduleDismiss, undoDismiss, usePendingDismissals, useQuestions } from '@/api/questions'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { deriveAttention } from '@/lib/attention'
import { composerEnterSends, useEnterInsertsNewline } from '@/lib/enter-key'
import { useLocation } from 'react-router'

import { Link, useActiveProjectId } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { DismissingNote, QuietClosedAsk, StaleNote } from '@/routes/questions/question-states'

import { useAskAnswer, type AskAnswerDelivery } from './ask-answer'
import { AskTextContext } from './ask-text'
import { ASK_MORE_INFO_ANSWER, AskAnswerSummary, askAnswerLines } from './ask-answer-summary'
import {
  type AskQuestionAnswer,
  type AskSelections,
  forgetAskSelections,
  readAskSelections,
  writeAskSelections,
} from './ask-selections'
import type { ThreadAsk } from './thread-state'
import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

export { ASK_MORE_INFO_ANSWER }

const EMPTY_ANSWER: AskQuestionAnswer = { labels: [] }

/** An open question is a run waiting on a person: the card wears the tone `deriveAttention`
 *  gives that state (blue, pulsing), never a hand-picked hue — so it can never disagree with the
 *  header dot above it (redesign 2026-11, status grammar). */
const ASKING = deriveAttention({ status: 'waiting' })

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
  // Closed by the server for any reason but a plain answer: one quiet line (Questions inbox).
  if (ask.closed && (ask.closed.reason !== 'answered' || ask.closed.answeredIn)) {
    return (
      <QuietClosedAsk
        closed={ask.closed}
        questions={ask.questions}
        asker="agent"
        link={ask.closed.reason === 'replaced' ? (
          <Link to={{ hash: '#ask' }} data-slot="ask-closed-newer" className="font-medium text-foreground underline underline-offset-4">Go to the newer question ↓</Link>
        ) : undefined}
      />
    )
  }
  const lines = ask.resolved && ask.answer ? askAnswerLines(ask, ask.answer) : null
  if (lines) {
    return (
      <div
        data-slot="ask-card"
        data-resolved="true"
        className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-label text-muted-foreground"
      >
        <span className="flex items-center gap-1 text-soft-foreground">
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Answered
        </span>
        <AskAnswerSummary questions={ask.questions} lines={lines} slot="ask-answers" />
      </div>
    )
  }
  // A reply in the user's own words: read back as they typed it.
  if (ask.resolved) {
    return (
      <div
        data-slot="ask-card"
        data-resolved="true"
        className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-label text-muted-foreground"
      >
        <CheckIcon aria-hidden="true" className="mr-1 inline size-3.5 align-[-2px] text-soft-foreground" />
        <span className="text-soft-foreground">Answered</span>
        {ask.answer ? (
          <span className="ml-1.5 break-words whitespace-pre-line text-foreground">{ask.answer}</span>
        ) : null}
      </div>
    )
  }
  return <PendingAsk ask={ask} run={run} />
}

/** The inbox key of a task's question: the listed item's when cached, else built from the route's project. */
function useTaskQuestionKey(run: ApiRun, requestId: string): string | undefined {
  const listed = useQuestions(false).data?.open.find((item) => item.source.kind === 'task' && item.source.runId === run.id && item.key.endsWith(`:${requestId}`))
  const projectId = useActiveProjectId()
  if (listed) return listed.key
  return projectId ? questionKey({ kind: 'task', projectId, runId: run.id, requestId }) : undefined
}

/** The unanswered card: option chips wired to whichever delivery seam the run's state allows. */
function PendingAsk({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
  const delivery = useAskAnswer(run, undefined, 'ask_answer', ask.id)
  const queryClient = useQueryClient()
  const key = useTaskQuestionKey(run, ask.id)
  const dismissing = usePendingDismissals().find((entry) => entry.key === key && !entry.error)
  // A typed reply flags the card on the run record rather than closing it (Questions inbox spec).
  const stale = run.asks?.find((record) => record.requestId === ask.id && !record.closed)?.stale
  if (key && dismissing) return <DismissingNote label={dismissing.label} onUndo={() => undoDismiss(key)} />
  return (
    <>
      {stale && key ? (
        <StaleNote detail={stale.detail} disabled={delivery.isPending} onDismiss={() => scheduleDismiss(queryClient, key, ask.questions[0]?.header ?? 'Question')} />
      ) : null}
      <AskForm
        ask={ask}
        ownerId={run.id}
        delivery={delivery}
        asker={ask.fromWorkflow ? 'The workflow is asking' : 'The agent is asking'}
      />
    </>
  )
}

/** The chips and their rules, whoever is asking: a task's agent, or a manager. */
export function AskForm({
  ask,
  ownerId,
  delivery,
  asker,
  composerBelow = true,
  framed = true,
}: {
  ask: Pick<ThreadAsk, 'id' | 'questions'>
  /** Keys the held picks, so they outlive a virtualized row. */
  ownerId: string
  delivery: Pick<AskAnswerDelivery, 'mode' | 'blockedBy' | 'reason' | 'isPending' | 'error' | 'send'>
  asker: string
  /** A composer sits under the card (a chat): the hint offers it. The Questions inbox has none. */
  composerBelow?: boolean
  /** The host draws its own frame and status (a manager card, a Questions row): no box, no asker row. */
  framed?: boolean
}) {
  const blocked = delivery.blockedBy !== undefined
  const questions = ask.questions
  // One-tap only when there is a single single-select question; every other
  // shape needs a combined Send so no question's answer is dropped.
  const oneTap = questions.length === 1 && questions[0]?.multiSelect !== true
  // Seeded from, and mirrored into, the store outside the card: the thread unmounts this row
  // whenever it scrolls out of a virtualized viewport, and the picks must outlive that (#1247).
  const [selections, setSelections] = useState<AskSelections>(() => readAskSelections(ownerId, ask))

  const setQuestion = (index: number, answer: AskQuestionAnswer) =>
    setSelections((prev) => {
      const next = { ...prev, [index]: answer }
      writeAskSelections(ownerId, ask, next)
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
  // Now's "Answer" opens the thread at `#ask`: bring the open question into view and hand it the
  // focus (spec: attention-first cockpit (2026-11-11), Proposal 2).
  const card = useRef<HTMLDivElement>(null)
  const { hash } = useLocation()
  useEffect(() => {
    if (hash !== '#ask' || !card.current) return
    revealAskCard(card.current)
  }, [hash])

  return (
    <div
      ref={card}
      data-slot="ask-card"
      data-resolved="false"
      data-delivery={delivery.mode}
      aria-busy={delivery.isPending || undefined}
      data-tone={ASKING.tone}
      className={framed ? 'rounded-lg border border-info/30 bg-info/5 px-4 pt-3.5 pb-3.5' : undefined}
    >
      {framed || delivery.isPending ? (
        <div className="mb-2.5 flex items-center gap-2">
          {framed ? (
            <>
              <StatusDot tone={ASKING.tone} pulse={ASKING.pulse} />
              {/* Ink, not the accent: a tinted word on the tinted card is under 2:1 as small text. */}
              <span data-slot="ask-asker" className="text-label font-semibold text-foreground">{asker}</span>
            </>
          ) : null}
          {/* A one-tap pick disables every chip at once; say why. */}
          {delivery.isPending ? (
            <span data-slot="ask-sending" role="status" className="ml-auto text-meta text-muted-foreground">
              Sending…
            </span>
          ) : null}
        </div>
      ) : null}
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
          <p data-slot="ask-resume-hint" className="mt-3 text-meta text-muted-foreground">
            The session has ended — your answer reopens it and goes to the agent.
          </p>
        ) : null
      ) : (
        // Wraps as a whole under the button on a phone rather than as a ragged column beside it.
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Button
            size="sm"
            disabled={delivery.isPending || blocked || !allAnswered}
            // Same legible disabled state as the composer's Send: half-opacity lime vanishes on light.
            className="pointer-coarse:min-h-11 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-[inset_0_0_0_1px_var(--border)]"
            onClick={sendAll}
          >
            {resuming ? 'Send answer & reopen' : 'Send answer'}
          </Button>
          {/* The slot names the resume state, so a selector for it can never match the ordinary
              "pick one or more" hint a live run shows. */}
          <span
            data-slot={resuming ? 'ask-resume-hint' : 'ask-hint'}
            className="min-w-0 text-meta text-muted-foreground"
          >
            {resuming
              ? 'the session has ended — sending reopens it'
              : `${questions.length > 1 ? 'answer each question' : 'pick one or more'}${composerBelow ? ' — or type a reply below' : ''}`}
          </span>
        </div>
      )}
      {/* Send stays disabled until every question has a pick; say which ones lack it, since a
          long card scrolls its earlier questions out of sight (#1247). */}
      {!oneTap && unanswered.length > 0 ? (
        <p data-slot="ask-unanswered" className="mt-2 text-meta text-muted-foreground">
          unanswered: {unanswered.join(', ')}
        </p>
      ) : null}
      {delivery.blockedBy === 'provider' ? (
        <div data-slot="ask-provider-gate" className="mt-3 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground">
          <span>{delivery.reason}</span>
          <Link to="/settings/agents#providers" className="font-medium text-foreground underline underline-offset-4">
            Configure providers
          </Link>
        </div>
      ) : null}
      {delivery.blockedBy === 'no-session' ? (
        <p data-slot="ask-no-session" className="mt-3 text-label text-muted-foreground">
          {delivery.reason}
        </p>
      ) : null}
      {/* A dropped answer used to be silent — the tap did nothing and said nothing. */}
      {delivery.error ? (
        <p data-slot="ask-error" role="alert" className="mt-3 text-label text-danger">
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
  const text = useContext(AskTextContext)
  const newlineOnEnter = useEnterInsertsNewline()
  const questionId = useId()
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
    <div role="group" aria-labelledby={questionId}>
      <div className="mb-0.5 flex items-center gap-2">
        <span className="rounded-md bg-primary px-1.5 py-0.5 eyebrow text-primary-foreground">
          {question.header}
        </span>
        {multiSelect ? (
          <span aria-hidden="true" className="ml-auto text-micro text-soft-foreground">select all that apply</span>
        ) : null}
      </div>
      <p id={questionId} className="mb-2.5 break-words text-body font-semibold text-foreground">
        {text.render(question.question)}
        {multiSelect ? <span className="sr-only"> (select all that apply)</span> : null}
      </p>
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
              aria-label={`Your own answer: ${text.plain(question.question)}`}
              placeholder="Type your own answer"
              value={answer.other}
              disabled={disabled}
              // Same rule as the composer: on a phone Enter is a newline and only Send sends.
              enterKeyHint={oneTap && !newlineOnEnter ? 'send' : 'enter'}
              onChange={(event) => onChange({ ...answer, other: event.target.value })}
              onKeyDown={(event) => {
                const sends = composerEnterSends({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  altKey: event.altKey,
                  repeat: event.repeat,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.keyCode,
                }, newlineOnEnter)
                if (oneTap && sends) {
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
  const text = useContext(AskTextContext)
  const descriptionId = useId()
  const box = cn(
    'flex w-full flex-col gap-0.5 rounded-md border px-3.5 py-2.5 text-left outline-none transition-colors motion-reduce:transition-none pointer-coarse:min-h-11',
    selected ? 'border-primary/60 bg-primary/[0.06]' : 'border-border bg-card',
  )
  const content = (
    <>
      <span className="flex min-w-0 items-start gap-2 text-ui font-semibold text-foreground">
        {checkbox ? (
          <span
            aria-hidden
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded border text-micro',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-soft-foreground',
            )}
          >
            {selected ? '✓' : ''}
          </span>
        ) : null}
        <span className="min-w-0 break-words">{text.render(label, 'option')}</span>
      </span>
      {description ? (
        <span id={descriptionId} className="min-w-0 break-words text-label text-muted-foreground">{text.render(description, 'option')}</span>
      ) : null}
    </>
  )
  // A chip is a link of its own, and a link inside a button is neither: the button lies over the
  // whole option and the chips sit above it, so a click on a chip opens it and anywhere else picks.
  if (text.interactive(label) || (description !== undefined && text.interactive(description))) {
    return (
      <div
        data-slot="ask-choice"
        className={cn(
          box,
          'relative has-[>button:hover]:border-primary/50 has-[>button:hover]:bg-primary/[0.06]',
          'has-[>button:focus-visible]:ring-[3px] has-[>button:focus-visible]:ring-ring/50',
          disabled && 'opacity-50',
        )}
      >
        <button
          type="button"
          disabled={disabled}
          aria-pressed={selected}
          aria-label={text.plain(label)}
          {...(description ? { 'aria-describedby': descriptionId } : {})}
          onClick={onClick}
          className="absolute inset-0 rounded-md outline-none"
        />
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-slot="ask-choice"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        box,
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'hover:border-primary/50 hover:bg-primary/[0.06] disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      {content}
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
        'rounded-md border border-dashed px-3 py-1.5 text-label font-medium text-muted-foreground outline-none transition-colors motion-reduce:transition-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11 pointer-coarse:px-3.5',
        'hover:border-primary/50 hover:bg-primary/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        selected ? 'border-primary/60 bg-primary/[0.06] text-foreground' : 'border-border bg-card',
      )}
    >
      {children}
    </button>
  )
}

/** Bring an open question card into view and hand it the focus (the `#ask` deep link, the header's Answer). */
export function revealAskCard(card: HTMLElement): void {
  card.scrollIntoView?.({ block: 'center' })
  card.querySelector<HTMLElement>('button, input, textarea')?.focus()
}

/** The latest unresolved question card inside `root`, or null when none is mounted. */
export function latestOpenAskCard(root: ParentNode): HTMLElement | null {
  const cards = root.querySelectorAll<HTMLElement>('[data-slot="ask-card"][data-resolved="false"]')
  return cards.length > 0 ? cards[cards.length - 1]! : null
}

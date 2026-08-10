import { useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { useAskAnswer } from './ask-answer'
import type { ThreadAsk } from './thread-state'
import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

/** Format one answered question the way the agent reads it back. */
function formatAnswer(question: UiAskQuestion, labels: string[]): string {
  return `${question.header}: ${labels.join(', ')}`
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
 * as its opening prompt. The composer below stays available for a free-form
 * "Other". Once resolved, the card collapses to a compact summary.
 */
export function AskCard({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
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
  const [selections, setSelections] = useState<Record<number, string[]>>({})

  const setQuestion = (index: number, labels: string[]) =>
    setSelections((prev) => ({ ...prev, [index]: labels }))

  const allAnswered = questions.every((_, index) => (selections[index]?.length ?? 0) > 0)

  const sendAll = () =>
    void delivery.send(
      questions.map((q, index) => formatAnswer(q, selections[index] ?? [])).join('\n'),
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
        <span className="text-xs font-medium text-primary">The agent is asking</span>
      </div>
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <AskQuestionBlock
            key={question.id ?? index}
            question={question}
            disabled={delivery.isPending || blocked}
            selected={selections[index] ?? []}
            onSelect={(labels) => {
              if (blocked) return
              if (oneTap) void delivery.send(formatAnswer(question, labels))
              else setQuestion(index, labels)
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
  selected,
  onSelect,
}: {
  question: UiAskQuestion
  disabled: boolean
  selected: string[]
  onSelect: (labels: string[]) => void
}) {
  const multiSelect = question.multiSelect === true

  const pick = (label: string) => {
    if (!multiSelect) {
      onSelect([label])
      return
    }
    onSelect(
      selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label],
    )
  }

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
        {question.options.map((option) => {
          const isSelected = selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              disabled={disabled}
              aria-pressed={isSelected}
              onClick={() => pick(option.label)}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-md border px-3.5 py-2.5 text-left transition-colors',
                'hover:border-primary/50 hover:bg-primary/[0.06] disabled:pointer-events-none disabled:opacity-50',
                isSelected ? 'border-primary/60 bg-primary/[0.06]' : 'border-border bg-card',
              )}
            >
              <span className="flex min-w-0 items-start gap-2 text-[13.5px] font-semibold text-foreground">
                {multiSelect ? (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border text-[10px]',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-soft-foreground',
                    )}
                  >
                    {isSelected ? '✓' : ''}
                  </span>
                ) : null}
                <span className="min-w-0 break-words">{option.label}</span>
              </span>
              {option.description ? (
                <span className="min-w-0 break-words text-xs text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

import { useState } from 'react'

import { useSendMessage } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { useActiveProviderAvailability } from './active-provider'
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
 * way the answer rides the normal reply seam (`useSendMessage` →
 * `POST /api/runs/:id/messages`), and the composer below stays enabled for a
 * free-form "Other". Once resolved, the card collapses to a compact summary.
 */
export function AskCard({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
  const sendMessage = useSendMessage(run.id)
  const provider = useActiveProviderAvailability(run)
  const providerBlocked = !provider.usable
  const questions = ask.questions
  // One-tap only when there is a single single-select question; every other
  // shape needs a combined Send so no question's answer is dropped.
  const oneTap = questions.length === 1 && questions[0]?.multiSelect !== true
  const [selections, setSelections] = useState<Record<number, string[]>>({})

  if (ask.resolved) {
    return (
      <div
        data-slot="ask-card"
        data-resolved="true"
        className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground"
      >
        <span className="text-soft-foreground">Answered</span>
        {ask.answer ? (
          <span className="ml-1.5 whitespace-pre-line text-foreground">{ask.answer}</span>
        ) : null}
      </div>
    )
  }

  const setQuestion = (index: number, labels: string[]) =>
    setSelections((prev) => ({ ...prev, [index]: labels }))

  const allAnswered = questions.every((_, index) => (selections[index]?.length ?? 0) > 0)

  const sendAll = () =>
    void sendMessage.mutateAsync({
      text: questions.map((q, index) => formatAnswer(q, selections[index] ?? [])).join('\n'),
    })

  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
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
            disabled={sendMessage.isPending || providerBlocked}
            selected={selections[index] ?? []}
            onSelect={(labels) => {
              if (providerBlocked) return
              if (oneTap) void sendMessage.mutateAsync({ text: formatAnswer(question, labels) })
              else setQuestion(index, labels)
            }}
          />
        ))}
      </div>
      {oneTap ? null : (
        <div className="mt-3 flex items-center gap-2.5">
          <Button size="sm" disabled={sendMessage.isPending || providerBlocked || !allAnswered} onClick={sendAll}>
            Send answer
          </Button>
          <span className="text-[11.5px] text-soft-foreground">
            {questions.length > 1 ? 'answer each question' : 'pick one or more'} — or type a reply below
          </span>
        </div>
      )}
      {providerBlocked ? (
        <div data-slot="ask-provider-gate" className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{provider.reason}</span>
          <Link to="/settings/agents#providers" className="font-medium text-foreground underline underline-offset-4">
            Configure providers
          </Link>
        </div>
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
      <p className="mb-2.5 text-sm font-semibold text-foreground">{question.question}</p>
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
              <span className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
                {multiSelect ? (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 items-center justify-center rounded border text-[10px]',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-soft-foreground',
                    )}
                  >
                    {isSelected ? '✓' : ''}
                  </span>
                ) : null}
                {option.label}
              </span>
              {option.description ? (
                <span className="text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

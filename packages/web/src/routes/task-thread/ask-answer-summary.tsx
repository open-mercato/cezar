import { CheckIcon, PencilLineIcon } from 'lucide-react'
import { useContext } from 'react'

import { StaticChip } from '@/components/chip'
import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

import { AskTextContext } from './ask-text'

/** What "Need more info" sends; the CEZ:ASK instructions (`handoff.ts`) tell the agent to
 *  explain the question and ask it again. */
export const ASK_MORE_INFO_ANSWER =
  'I need more information to answer this — please explain the context and ask again.'

export interface AskAnswerLine {
  header: string
  value: string
}

/**
 * The card's own answer read back per question (`Header: choice` per line, as the ask form sends
 * it), or null when the text is not shaped like one: a reply typed in the composer stays prose.
 */
export function askAnswerLines(ask: { questions: readonly Pick<UiAskQuestion, 'header'>[] }, text: string): AskAnswerLine[] | null {
  const lines = text.split('\n')
  if (lines.length !== ask.questions.length) return null
  const answers = lines.map((line, index) => {
    const prefix = `${ask.questions[index]?.header ?? ''}: `
    return line.startsWith(prefix) ? { header: ask.questions[index]!.header, value: line.slice(prefix.length) } : null
  })
  return answers.every((entry) => entry !== null && entry.value.trim() !== '') ? answers as AskAnswerLine[] : null
}

export interface ReadAnswer {
  /** Option labels picked, in the order the form joined them. */
  picks: string[]
  /** The user's own text ("Other…"), when any. */
  own?: string
  moreInfo?: boolean
}

/** Split one answer line back into the picks and own text the form joined with `, `. */
export function readAskAnswer(question: Pick<UiAskQuestion, 'options'>, value: string): ReadAnswer {
  if (value === ASK_MORE_INFO_ANSWER) return { picks: [], moreInfo: true }
  // Longest first, so a label that prefixes another ("Yes" / "Yes, later") never steals it.
  const labels = question.options.map((option) => option.label).sort((a, b) => b.length - a.length)
  const picks: string[] = []
  let rest = value
  while (rest !== '') {
    const label = labels.find((candidate) => !picks.includes(candidate) && (rest === candidate || rest.startsWith(`${candidate}, `)))
    if (!label) break
    picks.push(label)
    rest = rest.slice(Math.min(rest.length, label.length + 2))
  }
  return rest === '' ? { picks } : { picks, own: rest }
}

/**
 * An answered card as chips (the open card's own language): every option of each question, the
 * chosen one in the `active` face with a check, the user's own text and "Need more info" dashed.
 */
export function AskAnswerSummary({ questions, lines, slot }: {
  questions: readonly UiAskQuestion[]
  lines: readonly AskAnswerLine[]
  slot: string
}) {
  const text = useContext(AskTextContext)
  return (
    <dl data-slot={slot} className="flex flex-col gap-2">
      {lines.map(({ header, value }, index) => {
        const question = questions[index]
        const read = question ? readAskAnswer(question, value) : { picks: [], own: value }
        const chosen = question?.options.filter((option) => read.picks.includes(option.label) && option.description) ?? []
        return (
          <div key={index} data-slot="ask-answer" className="flex min-w-0 flex-col gap-1">
            <dt className="eyebrow text-muted-foreground">{header}<span className="sr-only">:</span></dt>
            <dd className="min-w-0">
              <ul className="flex flex-wrap gap-1.5">
                {question?.options.map((option) => {
                  const picked = read.picks.includes(option.label)
                  return (
                    <li key={option.label} className="flex min-w-0 max-w-full">
                      <StaticChip
                        active={picked}
                        title={option.description === undefined ? undefined : text.plain(option.description)}
                        icon={picked ? <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-success" /> : undefined}
                      >
                        {/* A chip inside a chip reads as two: the label's references stay words here. */}
                        {text.plain(option.label)}
                        {picked ? <span className="sr-only"> (chosen)</span> : null}
                      </StaticChip>
                    </li>
                  )
                })}
                {read.own ? (
                  <li className="flex min-w-0 max-w-full">
                    <StaticChip active dashed data-answer="other" icon={<PencilLineIcon aria-hidden="true" className="size-3 shrink-0" />}>
                      <span className="sr-only">Own answer: </span>
                      {read.own}
                    </StaticChip>
                  </li>
                ) : null}
                {read.moreInfo ? (
                  <li className="flex min-w-0 max-w-full">
                    <StaticChip active dashed data-answer="more-info">
                      Need more info<span className="sr-only"> (chosen)</span>
                    </StaticChip>
                  </li>
                ) : null}
              </ul>
              {chosen.map((option) => (
                <p key={option.label} data-slot="ask-answer-description" className="mt-1 break-words text-meta text-muted-foreground">
                  {text.render(option.description!)}
                </p>
              ))}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

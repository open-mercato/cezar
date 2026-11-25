import type { ApiRun, UiAskQuestion, UiToolItem } from '@open-mercato/cezar-api-client'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { isStageDoneAsk, STAGE_DONE_NOT_YET, STAGE_DONE_YES } from '@/lib/cards'
import { composerEnterSends, useEnterInsertsNewline } from '@/lib/enter-key'
import { cn } from '@/lib/utils'

import { useAskAnswer } from '../task-thread/ask-answer'
import { askAnswerLines, readAskAnswer } from '../task-thread/ask-answer-summary'
import { formatAskAnswer, isAskAnswered } from '../task-thread/ask-card'
import { forgetAskSelections, readAskSelections, writeAskSelections, type AskQuestionAnswer, type AskSelections } from '../task-thread/ask-selections'
import { useDeliverPrompt } from '../task-thread/deliver-prompt'
import { useContinueAction } from '../task-thread/follow-up-engine'
import { Markdown } from '../task-thread/markdown'
import type { ThreadAsk, ThreadState } from '../task-thread/thread-state'
import { chatRows, type ChatRow } from './card-chat-rows'

/**
 * The card wizard's conversation (spec 2026-11-15-framework-board, mockup 3): compact AI/Me rows,
 * asks inline as chip boxes, one plain composer. Delivery is the task view's own — `useAskAnswer`
 * for an ask, `useDeliverPrompt` for a reply — so nothing here speaks the protocol itself.
 */
export function CardChat({
  run,
  thread,
  stage,
  next,
  actions,
  older,
}: {
  run: ApiRun
  thread: ThreadState
  /** The current stage's display name and the next one's, for the stage-done box. */
  stage: string
  next?: string
  /** The composer's right-hand buttons (Let the agent decide, Finish stage). */
  actions?: React.ReactNode
  older?: { hasOlder: boolean; loading: boolean; load: () => void }
}) {
  const rows = React.useMemo(() => chatRows(thread), [thread])
  const log = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  // Follow the newest row while the reader is at the bottom; leave them alone once they scroll up.
  React.useLayoutEffect(() => {
    const el = log.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [rows])
  const working = run.status === 'running'

  return (
    <div data-slot="card-chat" className="flex min-h-0 flex-col">
      <div
        ref={log}
        data-slot="card-thread"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="max-h-[min(64dvh,720px)] min-h-0 overflow-y-auto overscroll-contain"
      >
        {older?.hasOlder ? (
          <button type="button" disabled={older.loading} onClick={older.load} className="mb-1 text-meta text-muted-foreground hover:text-foreground">
            {older.loading ? 'Loading earlier messages…' : '↑ Earlier messages'}
          </button>
        ) : null}
        {rows.length === 0 && !working ? <p className="py-2.5 text-label text-muted-foreground">No messages yet.</p> : null}
        {rows.map((row) => (
          <ChatRowView key={row.id} row={row} run={run} stage={stage} next={next} />
        ))}
        {working ? (
          <MessageRow who="ai">
            <span data-slot="card-chat-working" role="status" className="inline-flex items-center gap-1.5 text-label text-muted-foreground">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-violet motion-reduce:animate-none" />
              Working…
            </span>
          </MessageRow>
        ) : null}
      </div>
      <ChatComposer run={run} actions={actions} />
    </div>
  )
}

function Badge({ who }: { who: 'ai' | 'me' }) {
  return (
    <span
      aria-label={who === 'ai' ? 'Agent' : 'You'}
      data-slot="chat-badge"
      className={cn(
        'mt-px inline-grid size-6 shrink-0 place-items-center rounded-[6px] text-meta font-bold',
        who === 'ai' ? 'bg-violet/15 text-violet' : 'bg-info/15 text-info',
      )}
    >
      {who === 'ai' ? 'AI' : 'Me'}
    </span>
  )
}

function MessageRow({ who, ts, children }: { who: 'ai' | 'me'; ts?: string; children: React.ReactNode }) {
  return (
    <div
      data-slot="chat-row"
      data-who={who}
      title={ts ? new Date(ts).toLocaleString() : undefined}
      className="flex gap-2.5 border-b border-border py-2.5 last:border-b-0"
    >
      <Badge who={who} />
      <div className="min-w-0 flex-1 text-ui text-foreground">{children}</div>
    </div>
  )
}

/** Chat-scale prose, a notch tighter than the task view's turns. */
function Prose({ text, user }: { text: string; user?: boolean }) {
  return (
    <div className="[&_.thread-markdown]:leading-[1.5] [&_.thread-markdown_:is(p,ul,ol,table,blockquote)]:my-1 [&_.thread-markdown>*:first-child]:mt-0 [&_.thread-markdown>*:last-child]:mb-0">
      <Markdown breaks={user}>{text}</Markdown>
    </div>
  )
}

function ChatRowView({ row, run, stage, next }: { row: ChatRow; run: ApiRun; stage: string; next?: string }) {
  switch (row.kind) {
    case 'me':
      return (
        <MessageRow who="me" ts={row.ts}>
          <Prose text={row.text} user />
        </MessageRow>
      )
    case 'ai':
      return (
        <MessageRow who="ai" ts={row.ts}>
          <Prose text={row.text} />
        </MessageRow>
      )
    case 'tools':
      return <ToolsLine tools={row.tools} />
    case 'ask':
      return (
        <MessageRow who="ai" ts={row.ts}>
          <ChatAsk ask={row.ask} run={run} stage={stage} next={next} />
        </MessageRow>
      )
    case 'note':
      return (
        <p data-slot="chat-note" className={cn('py-1.5 pl-[34px] text-meta', row.tone === 'danger' ? 'text-danger' : 'text-soft-foreground')}>
          {row.text}
        </p>
      )
  }
}

function ToolsLine({ tools }: { tools: UiToolItem[] }) {
  const [open, setOpen] = React.useState(false)
  const failed = tools.filter((t) => t.status === 'failed').length
  return (
    <div data-slot="chat-tools" className="py-1 pl-[34px] text-meta text-soft-foreground">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="hover:text-foreground">
        · ran {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
        {failed ? <span className="text-danger"> · {failed} failed</span> : null} {open ? '▴' : '▾'}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono">
          {tools.map((t) => (
            <li key={t.id} className={cn('truncate', t.status === 'failed' && 'text-danger')} title={t.title}>
              {t.title}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const CHIP =
  'rounded-full border px-2.5 py-1 text-label outline-none transition-colors motion-reduce:transition-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-10 disabled:pointer-events-none disabled:opacity-50'
const chipTone = (on: boolean) =>
  on ? 'border-success bg-success/10 text-success-strong' : 'border-border text-foreground hover:border-success/60'

function Chip({ on, children, ...props }: { on: boolean } & React.ComponentProps<'button'>) {
  return (
    <button type="button" data-slot="chat-chip" aria-pressed={on} className={cn(CHIP, chipTone(on))} {...props}>
      {children}
    </button>
  )
}

function AskBox({ done, children, slot }: { done?: boolean; children: React.ReactNode; slot?: string }) {
  return (
    <div data-slot={slot ?? 'chat-ask'} className={cn('mt-2 rounded-lg border bg-muted/30 p-2.5 first:mt-0', done ? 'border-success/40' : 'border-border')}>
      {children}
    </div>
  )
}

/** An ask, answered or not. Open: chips wired to `useAskAnswer`. Answered: the same chips, read back. */
function ChatAsk({ ask, run, stage, next }: { ask: ThreadAsk; run: ApiRun; stage: string; next?: string }) {
  React.useEffect(() => {
    if (ask.resolved) forgetAskSelections(run.id, ask)
  }, [ask, run.id])
  const stageDone = isStageDoneAsk(ask)
  const title = stageDone ? `${stage} looks complete — ${next ? `move on to ${next}?` : 'finish this stage?'}` : undefined

  if (ask.closed && ask.closed.reason !== 'answered') {
    return <p data-slot="chat-ask-closed" className="text-label text-muted-foreground">A question was closed ({ask.closed.reason}).</p>
  }
  if (ask.resolved) {
    const lines = ask.answer ? askAnswerLines(ask, ask.answer) : null
    return (
      <div data-slot="chat-ask-answered" data-resolved="true">
        {ask.questions.map((q, i) => {
          const read = lines?.[i] ? readAskAnswer(q, lines[i]!.value) : undefined
          return (
            <AskBox key={i} done={stageDone}>
              <b className="font-semibold">{title ?? q.question}</b>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const on = read?.picks.includes(o.label) ?? false
                  return (
                    <span key={o.label} className={cn(CHIP, on ? chipTone(true) : 'border-border text-muted-foreground')}>
                      {stageDone ? stageDoneLabel(o.label, stage) : o.label}
                    </span>
                  )
                })}
                {read?.own ? <span className={cn(CHIP, chipTone(true))}>{read.own}</span> : null}
                {!lines ? <span className="text-meta text-muted-foreground">answered in the chat</span> : null}
              </div>
            </AskBox>
          )
        })}
      </div>
    )
  }
  return <PendingChatAsk ask={ask} run={run} stageDone={stageDone} stage={stage} title={title} />
}

const stageDoneLabel = (label: string, stage: string) =>
  label === STAGE_DONE_YES ? `Yes, finish ${stage}` : label === STAGE_DONE_NOT_YET ? 'Not yet — more questions' : label

function PendingChatAsk({ ask, run, stageDone, stage, title }: { ask: ThreadAsk; run: ApiRun; stageDone: boolean; stage: string; title?: string }) {
  const delivery = useAskAnswer(run, undefined, 'ask_answer', ask.id)
  const [selections, setSelections] = React.useState<AskSelections>(() => readAskSelections(run.id, ask))
  const blocked = delivery.blockedBy !== undefined
  const disabled = blocked || delivery.isPending
  const questions = ask.questions
  const oneTap = stageDone || (questions.length === 1 && questions[0]?.multiSelect !== true)
  const resuming = delivery.mode === 'resume'
  const answerOf = (i: number): AskQuestionAnswer => selections[i] ?? { labels: [] }
  const allAnswered = questions.every((_, i) => isAskAnswered(answerOf(i)))

  const set = (i: number, answer: AskQuestionAnswer) =>
    setSelections((prev) => {
      const nextSel = { ...prev, [i]: answer }
      writeAskSelections(run.id, ask, nextSel)
      return nextSel
    })
  const sendOne = (q: UiAskQuestion, answer: AskQuestionAnswer) => {
    if (!disabled && isAskAnswered(answer)) void delivery.send(formatAskAnswer(q, answer))
  }
  const sendAll = () => {
    if (!disabled && allAnswered) void delivery.send(questions.map((q, i) => formatAskAnswer(q, answerOf(i))).join('\n'))
  }

  return (
    <div data-slot="chat-ask-open" data-resolved="false" data-delivery={delivery.mode} aria-busy={delivery.isPending || undefined}>
      {questions.map((q, i) => (
        <AskBox key={q.id ?? i} done={stageDone} slot={stageDone ? 'chat-stage-done' : 'chat-ask'}>
          <ChatQuestion
            question={q}
            title={title}
            answer={answerOf(i)}
            disabled={disabled}
            labelOf={stageDone ? (l) => stageDoneLabel(l, stage) : undefined}
            allowOther={!stageDone}
            onChange={(a) => {
              set(i, a)
              if (oneTap) sendOne(q, a)
            }}
            onOther={(a) => set(i, a)}
            onSubmitOther={(a) => (oneTap ? sendOne(q, a) : undefined)}
            oneTap={oneTap}
          />
        </AskBox>
      ))}
      {!oneTap || resuming || delivery.isPending ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!oneTap ? (
            <Button size="sm" disabled={disabled || !allAnswered} onClick={sendAll}>
              {resuming ? 'Send answer & reopen' : questions.length > 1 ? 'Send answers' : 'Send answer'}
            </Button>
          ) : null}
          {delivery.isPending ? (
            <span role="status" className="text-meta text-muted-foreground">Sending…</span>
          ) : resuming ? (
            <span data-slot="ask-resume-hint" className="text-meta text-muted-foreground">the session has ended — answering reopens it</span>
          ) : null}
        </div>
      ) : null}
      {delivery.reason ? <p className="mt-2 text-label text-muted-foreground">{delivery.reason}</p> : null}
      {delivery.error ? (
        <p role="alert" className="mt-2 text-label text-danger">
          {delivery.error}
        </p>
      ) : null}
    </div>
  )
}

function ChatQuestion({
  question,
  title,
  answer,
  disabled,
  labelOf,
  allowOther,
  oneTap,
  onChange,
  onOther,
  onSubmitOther,
}: {
  question: UiAskQuestion
  title?: string
  answer: AskQuestionAnswer
  disabled: boolean
  labelOf?: (label: string) => string
  allowOther: boolean
  oneTap: boolean
  /** A pick: sent at once on a one-tap ask, held otherwise. */
  onChange: (answer: AskQuestionAnswer) => void
  /** Typing in "Other…": always held. */
  onOther: (answer: AskQuestionAnswer) => void
  onSubmitOther: (answer: AskQuestionAnswer) => void
}) {
  const multi = question.multiSelect === true
  const otherOpen = answer.other !== undefined
  const newlineOnEnter = useEnterInsertsNewline()
  const id = React.useId()
  const pick = (label: string) => {
    if (!multi) return onChange({ labels: [label] })
    const labels = answer.labels.includes(label) ? answer.labels.filter((l) => l !== label) : [...answer.labels, label]
    onOther({ labels, ...(otherOpen ? { other: answer.other } : {}) })
  }
  return (
    <div role="group" aria-labelledby={id}>
      <b id={id} className="font-semibold">
        {title ?? question.question}
      </b>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {question.options.map((o) => (
          <Chip key={o.label} on={answer.labels.includes(o.label)} disabled={disabled} title={o.description} onClick={() => pick(o.label)}>
            {labelOf ? labelOf(o.label) : o.label}
          </Chip>
        ))}
        {allowOther ? (
          <Chip
            on={otherOpen}
            disabled={disabled}
            data-slot="chat-other"
            onClick={() => onOther(otherOpen ? { labels: answer.labels } : { labels: multi ? answer.labels : [], other: '' })}
          >
            Other…
          </Chip>
        ) : null}
      </div>
      {otherOpen ? (
        <div className="mt-2 flex items-start gap-2">
          <input
            // Opened by a click, so focusing it is what the user asked for.
            autoFocus
            aria-label={`Your own answer: ${question.question}`}
            placeholder="Type your own answer"
            value={answer.other}
            disabled={disabled}
            onChange={(e) => onOther({ ...answer, other: e.target.value })}
            onKeyDown={(e) => {
              const sends = composerEnterSends(
                { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, repeat: e.repeat, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode },
                newlineOnEnter,
              )
              if (sends && oneTap) {
                e.preventDefault()
                onSubmitOther(answer)
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-label outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {oneTap ? (
            <Button size="sm" disabled={disabled || !isAskAnswered(answer)} onClick={() => onSubmitOther(answer)}>
              Send
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The plain reply box: text only, the task view's delivery path (live message or Continue). */
function ChatComposer({ run, actions }: { run: ApiRun; actions?: React.ReactNode }) {
  const continueAction = useContinueAction(run)
  const deliver = useDeliverPrompt(run, continueAction.continueWith)
  const newlineOnEnter = useEnterInsertsNewline()
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const live = run.status === 'running' || run.status === 'waiting' || run.status === 'queued'
  const canSend = live || continueAction.available
  const send = async () => {
    const message = text.trim()
    if (!message || sending || !canSend) return
    setSending(true)
    try {
      await deliver(message, [])
      setText('')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      setSending(false)
    }
  }
  return (
    <div data-slot="card-composer" className="mt-3">
      <Textarea
        aria-label="Reply to the agent"
        placeholder="Reply to the agent…"
        rows={2}
        value={text}
        disabled={!canSend}
        enterKeyHint={newlineOnEnter ? 'enter' : 'send'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const sends = composerEnterSends(
            { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, repeat: e.repeat, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode },
            newlineOnEnter,
          )
          if (sends) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" data-action="card-chat-send" disabled={!text.trim() || sending || !canSend} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
        {!canSend ? <span className="text-meta text-muted-foreground">This session cannot take a reply — open the task view.</span> : null}
        <span className="flex-1" />
        {actions}
      </div>
    </div>
  )
}

import { BellRingIcon, CheckIcon, ChevronRightIcon, CircleAlertIcon, MessageCircleQuestionIcon, PaperclipIcon } from 'lucide-react'
import { memo, useContext, createContext, useEffect, useRef, useState, useMemo, type ComponentProps } from 'react'
import { Link } from 'react-router'

import { checkManager, managerAttachmentUrl, sendManagerMessage, stopManager } from '@/api/managers'
import { useProjects, useRunsIndex } from '@/api/queries'
import { ReferenceChip } from '@/components/reference-chip'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { ZoomableImage } from '@/components/zoomable-image'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { chipClass } from '@/components/picker-pill'
import {
  checkFailureCause,
  ISSUE_LINK_PREFIX,
  managerMessageTime,
  managerReferences,
  parseManagerText,
  parseReferenceLink,
  PR_LINK_PREFIX,
  TASK_LINK_PREFIX,
  UNKNOWN_PROJECT,
  type ManagerOrigin,
  type ManagerReferenceProject,
} from '@/lib/managers'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import { trackManagerMessageSent, trackManagerQuestionAnswered } from '@/lib/manager-telemetry'
import { Markdown, TranscriptLink } from '@/routes/task-thread/markdown'
import { AskForm } from '@/routes/task-thread/ask-card'
import { forgetAskSelections } from '@/routes/task-thread/ask-selections'
import {
  isImageAttachmentName,
  type ManagerAsk,
  type ManagerAttachment,
  type ManagerCommand,
  type ManagerMessage,
  type RunRecord,
} from '@open-mercato/cezar-api-client'

import { ActionCard, type DecideAction } from './manager-approval'
import { ManagerCard } from './manager-card'
import { SessionCard, TaskChipLabel, taskPath } from './manager-session-card'

const NO_PROJECTS: readonly ManagerReferenceProject[] = []

const OriginContext = createContext<ManagerOrigin>({ id: '', name: '' })

/** Pull request titles the chat already knows, from its merge proposals, keyed `project/number`. */
export const PrTitlesContext = createContext<ReadonlyMap<string, string>>(new Map())

/** Stable while no proposal changes, so a streamed delta does not re-render every chip. */
export function usePrTitles(messages: readonly ManagerMessage[]): ReadonlyMap<string, string> {
  const entries = JSON.stringify(messages.flatMap((message) =>
    message.kind === 'action' && message.action.type === 'merge-pr' && message.action.title
      ? [[`${message.action.projectId}/${message.action.number}`, message.action.title]]
      : []))
  return useMemo(() => new Map(JSON.parse(entries) as Array<[string, string]>), [entries])
}

/** The same bubble the task tables show. Its status comes from the reply's own provider. */
function ForgeReference({ kind, projectId, number }: { kind: 'PR' | 'Issue'; projectId: string; number: number }) {
  const project = useProjects().data?.projects.find((entry) => entry.id === projectId)
  const proposed = useContext(PrTitlesContext).get(`${projectId}/${number}`)
  // Named by the reference, not the manager: its title, the task that opened it, else its project.
  const task = useRunsIndex().data?.runs.find((run) =>
    kind === 'PR' && run.projectId === projectId && (run.prNumber === number || run.markerRefs?.pr === number))
  const about = (kind === 'PR' ? proposed : undefined) ?? (task ? runTitle(task as unknown as RunRecord) : project?.name)
  return (
    <ReferenceChip
      compact
      reference={{ kind, number, ...(project?.repoUrl ? { url: `${project.repoUrl}/${kind === 'PR' ? 'pull' : 'issues'}/${number}` } : {}) }}
      taskTitle={`#${number}${about ? `, ${about}` : ''}`}
      {...(projectId === UNKNOWN_PROJECT ? {} : { projectId })}
      className="align-middle no-underline"
    />
  )
}

/** A reference inside a sentence: the markdown stays whole and only the link is swapped. */
function ManagerLink({ href, children, ...props }: ComponentProps<'a'>) {
  const origin = useContext(OriginContext)
  const pr = parseReferenceLink(href, PR_LINK_PREFIX)
  if (pr) return <ForgeReference kind="PR" projectId={pr.projectId} number={Number(pr.id)} />
  const issue = parseReferenceLink(href, ISSUE_LINK_PREFIX)
  if (issue) return <ForgeReference kind="Issue" projectId={issue.projectId} number={Number(issue.id)} />
  const task = parseReferenceLink(href, TASK_LINK_PREFIX)
  if (task) {
    return (
      <Link to={taskPath(task.projectId, task.id)} state={{ manager: origin }} data-slot="manager-task-chip" className={cn(chipClass, 'inline-flex no-underline')}>
        <TaskChipLabel projectId={task.projectId} runId={task.id} />
      </Link>
    )
  }
  return <TranscriptLink href={href} {...props}>{children}</TranscriptLink>
}

const MARKDOWN_COMPONENTS = { a: ManagerLink }

function CommandRow({ command }: { command: ManagerCommand }) {
  return (
    <li className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
      <p className={cn('font-mono text-xs break-words', command.isError && 'text-danger')}>{command.summary}</p>
      {command.output ? (
        <pre className="mt-1 max-h-48 overflow-auto font-mono text-micro whitespace-pre-wrap text-muted-foreground">{command.output}</pre>
      ) : null}
    </li>
  )
}

/** "Ran 2 commands ▸" */
export function CommandsRow({ commands }: { commands: readonly ManagerCommand[] }) {
  const [open, setOpen] = useState(false)
  if (commands.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2" data-slot="manager-commands">
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm pointer-coarse:min-h-11 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Ran {commands.length} {commands.length === 1 ? 'command' : 'commands'}
        <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 flex flex-col gap-1">
          {commands.map((command) => <CommandRow key={command.id} command={command} />)}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function UserAttachments({ managerId, attachments }: { managerId: string; attachments: readonly ManagerAttachment[] }) {
  return (
    <div data-slot="manager-attachments" className="flex max-w-[80%] flex-wrap items-center justify-end gap-1.5">
      {attachments.map(({ file, name }) => {
        const url = managerAttachmentUrl(managerId, file)
        return isImageAttachmentName(file) ? (
          <ZoomableImage key={file} src={url} alt={name ?? 'attached'} className="max-h-40 max-w-[220px] rounded-md border border-border object-contain" />
        ) : (
          <a
            key={file}
            href={url}
            download={name ?? file}
            data-slot="manager-file"
            className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs no-underline hover:bg-muted/70"
          >
            <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{name ?? file}</span>
          </a>
        )
      })}
    </div>
  )
}

/**
 * The card's own answer read back per question (`Header: choice` per line, as the ask form sends
 * it), or null when the text is not shaped like one: a reply typed in the composer stays a bubble.
 */
export function askAnswerLines(ask: ManagerAsk, text: string): Array<{ header: string; value: string }> | null {
  const lines = text.split('\n')
  if (lines.length !== ask.questions.length) return null
  const answers = lines.map((line, index) => {
    const prefix = `${ask.questions[index]?.header ?? ''}: `
    return line.startsWith(prefix) ? { header: ask.questions[index]!.header, value: line.slice(prefix.length) } : null
  })
  return answers.every((entry) => entry !== null && entry.value.trim() !== '') ? answers as Array<{ header: string; value: string }> : null
}

/** User messages an answered card above them already shows: drawn once, on the card. */
export function answersShownOnCard(messages: readonly ManagerMessage[]): ReadonlySet<string> {
  const shown = new Set<string>()
  messages.forEach((message, index) => {
    const next = messages[index + 1]
    if (message.kind !== 'assistant' || !message.ask || message.askAnswer === undefined || next?.kind !== 'user') return
    if (next.attachments?.length || next.text !== message.askAnswer) return
    if (askAnswerLines(message.ask, next.text)) shown.add(next.id)
  })
  return shown
}

/** A `CEZ:ASK` card. Answering is just the user's next message, so the composer answers it too. */
function ManagerQuestions({
  managerId,
  messageId,
  ask,
  answer,
  answerOnCard,
}: {
  managerId: string
  messageId: string
  ask: ManagerAsk
  answer: string | undefined
  /** The next row is this answer and is not drawn: the card says it instead. */
  answerOnCard: boolean
}) {
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const card = useMemo(() => ({ id: messageId, questions: ask.questions }), [messageId, ask])
  const answered = useRef<HTMLDivElement>(null)
  // Answered from this card: its chips unmount, so focus lands on what replaced them.
  const sentHere = useRef(false)
  useEffect(() => {
    if (answer === undefined) return
    forgetAskSelections(managerId, card)
    if (!sentHere.current) return
    sentHere.current = false
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) answered.current?.focus({ preventScroll: true })
  }, [answer, card, managerId])
  const lines = answer !== undefined && answerOnCard ? askAnswerLines(ask, answer) : null
  if (lines) {
    return (
      <div
        ref={answered}
        tabIndex={-1}
        data-slot="manager-ask"
        data-resolved="true"
        className="inline-flex max-w-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex items-center gap-1.5">
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          Answered
        </span>
        <dl data-slot="manager-ask-answers" className="flex flex-col gap-0.5 pl-5">
          {lines.map(({ header, value }, index) => (
            <div key={index} className="flex min-w-0 flex-wrap gap-x-1.5">
              <dt>{header}<span className="sr-only">:</span></dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  if (answer !== undefined) {
    return (
      <div
        ref={answered}
        tabIndex={-1}
        data-slot="manager-ask"
        data-resolved="true"
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* Answered in other words (typed, or with files): that message below says it (#2038 walk). */}
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        <span>Answered<span className="sr-only">:</span></span>
        <span data-slot="manager-ask-topics" className="min-w-0 break-words text-foreground">{ask.questions.map((question) => question.header).join(' · ')}</span>
      </div>
    )
  }
  const send = async (text: string) => {
    sentHere.current = true
    setPending(true)
    setError(undefined)
    try {
      await sendManagerMessage(managerId, text)
      trackManagerMessageSent('question_card', false)
      trackManagerQuestionAnswered('card')
      return undefined
    } catch (failure) {
      sentHere.current = false
      const message = failure instanceof Error ? failure.message : 'Your answer did not reach the manager.'
      setError(message)
      return message
    } finally {
      setPending(false)
    }
  }
  return (
    <ManagerCard
      data-slot="manager-ask"
      data-resolved="false"
      icon={<MessageCircleQuestionIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      title="Your decision"
      status={<><StatusDot tone="info" />Open</>}
    >
      {/* The form's own box and asker line are the card's now; its "Other…" and "Need more info"
          chips per question are the design's ghost actions. */}
      <div className="[&_[data-slot=ask-asker]]:hidden [&_[data-slot=ask-card]]:border-0 [&_[data-slot=ask-card]]:bg-transparent [&_[data-slot=ask-card]]:p-0">
        <AskForm
          ask={card}
          ownerId={managerId}
          delivery={{ mode: 'live', isPending, ...(error ? { error } : {}), send }}
          asker="Your decision"
        />
      </div>
    </ManagerCard>
  )
}

const THINKING_DELAYS = ['0ms', '160ms', '320ms']

/** A reply with no words yet: without it the row is a bare timestamp, and a phone keyboard hides
 *  the footer spinner. Not a live region — the announcer speaks once the reply settles. */
function Thinking() {
  return (
    <p data-slot="manager-thinking" className="flex items-baseline gap-1 text-sm text-muted-foreground">
      Thinking<span className="sr-only">…</span>
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {THINKING_DELAYS.map((delay) => (
          <span key={delay} style={{ animationDelay: delay }} className="size-1 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
        ))}
      </span>
    </p>
  )
}

function AssistantMessage({
  message,
  origin,
  projects,
  answerOnCard,
}: {
  message: Extract<ManagerMessage, { kind: 'assistant' }>
  origin: ManagerOrigin
  projects: readonly ManagerReferenceProject[]
  answerOnCard: boolean
}) {
  const segments = useMemo(
    () => parseManagerText(message.text, message.commands, projects),
    [message.text, message.commands, projects],
  )
  const references = useMemo(() => managerReferences(segments), [segments])
  return (
    <article data-slot="manager-assistant" className="min-w-0">
      <p data-slot="manager-message-meta" className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
        {message.turn === 'job' && message.jobName ? <span className="font-medium">Job: {message.jobName}</span> : null}
        {message.turn === 'watch' ? <span className="font-medium">Watch check</span> : null}
        <time dateTime={message.at} title={new Date(message.at).toLocaleString()}>{managerMessageTime(message.at)}</time>
      </p>
      {message.important ? (
        <p data-slot="manager-important" className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <BellRingIcon aria-hidden="true" className="size-3.5 text-pending-strong" />
          {message.headline ?? 'Important'}
        </p>
      ) : null}
      <CommandsRow commands={message.commands} />
      {message.streaming && message.text.trim() === '' ? <Thinking /> : null}
      <OriginContext.Provider value={origin}>
        <ReferenceStatusProvider requests={references}>
          {segments.map((segment, index) =>
            segment.kind === 'markdown' ? (
              <Markdown key={index} components={MARKDOWN_COMPONENTS}>{segment.text}</Markdown>
            ) : (
              <SessionCard key={index} projectId={segment.projectId} runId={segment.runId} origin={origin} />
            ),
          )}
        </ReferenceStatusProvider>
      </OriginContext.Provider>
      {message.ask ? (
        <div className="mt-3 max-w-2xl">
          <ManagerQuestions managerId={origin.id} messageId={message.id} ask={message.ask} answer={message.askAnswer} answerOnCard={answerOnCard} />
        </div>
      ) : null}
      {message.stopped ? <p className="mt-1 text-sm text-muted-foreground italic">Response stopped.</p> : null}
      {message.resumeAt ? <ResumeHint managerId={origin.id} at={message.resumeAt} /> : null}
      {message.error && message.turn !== 'chat' ? (
        <CheckFailedCard managerId={origin.id} turn={message.turn} jobName={message.jobName} error={message.error} at={message.at} />
      ) : message.error ? (
        // No `role="alert"`: a chat opened on old failures must not shout them all; the announcer says new ones.
        <p data-slot="manager-error" className="mt-1 flex items-start gap-1.5 text-sm text-danger">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {message.error}
        </p>
      ) : null}
    </article>
  )
}

/** What the chat around a row can do for it: open the gear on the account picker. Absent in a
 *  bare render, where the button that needs it stays away. */
export interface ManagerChatActions {
  switchAccount?: () => void
}

export const ManagerChatActionsContext = createContext<ManagerChatActions>({})

/**
 * A watch or job turn that failed (design, Proposal 10): a cause in words, the raw message under
 * it, and the two things the user can do. Replaces the red line that said "claude CLI exited with
 * code 1" under "Watch check". The next check retries by itself (spec, Watching).
 */
function CheckFailedCard({ managerId, turn, jobName, error, at }: { managerId: string; turn: 'watch' | 'job'; jobName: string | undefined; error: string; at: string }) {
  const cause = checkFailureCause(error)
  const actions = useContext(ManagerChatActionsContext)
  const [retrying, setRetrying] = useState(false)
  const retry = () => {
    setRetrying(true)
    checkManager(managerId)
      .then(() => toast('Check started'))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setRetrying(false))
  }
  return (
    <ManagerCard
      data-slot="manager-check-failed"
      data-cause={cause.kind}
      aria-label={turn === 'job' ? 'Job failed' : 'Check failed'}
      tone="danger"
      className="mt-2"
      icon={<StatusDot tone="danger" />}
      title={turn === 'job' ? `Job failed${jobName ? `: ${jobName}` : ''}` : 'Check failed'}
      status={<time dateTime={at}>{managerMessageTime(at)}</time>}
      actions={(
        <>
          <Button variant="outline" size="sm" disabled={retrying} onClick={retry}>Retry now</Button>
          {cause.switchAccount && actions.switchAccount ? (
            <Button variant="ghost" size="sm" onClick={actions.switchAccount}>Switch account</Button>
          ) : null}
        </>
      )}
    >
      <p>{cause.sentence} {turn === 'job' ? 'It runs again on its own interval.' : 'The next check retries.'}</p>
      <p data-slot="manager-check-failed-raw" className="font-mono text-xs break-words text-muted-foreground">{error}</p>
    </ManagerCard>
  )
}

/** A usage limit ended the turn: it is waiting, not broken — the task view's auto-resume hint. */
function ResumeHint({ managerId, at }: { managerId: string; at: string }) {
  const [pending, setPending] = useState(false)
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const label = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date)
  const cancel = () => {
    setPending(true)
    stopManager(managerId)
      .then(() => toast('This manager will not resume itself'))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setPending(false))
  }
  return (
    <p data-slot="manager-resume-hint" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <StatusDot tone="pending" pulse />
      <span>
        Usage limit reached — resumes automatically at{' '}
        <time dateTime={at} className="font-medium text-foreground">{label}</time>
      </span>
      <button
        type="button"
        data-action="manager-resume-cancel"
        disabled={pending}
        onClick={cancel}
        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:opacity-50"
      >
        Don’t resume
      </button>
    </p>
  )
}

/** One chat row. Memoized: a streaming reply re-renders only the message that grew. */
export const ManagerMessageRow = memo(function ManagerMessageRow({
  message,
  origin,
  onDecide,
  projects = NO_PROJECTS,
  answerOnCard = false,
}: {
  message: ManagerMessage
  origin: ManagerOrigin
  /** An answered card whose answer, the next message, is drawn here and not as its own row. */
  answerOnCard?: boolean
  /** Connected projects: what a bare `#12` or a GitHub URL resolves against. */
  projects?: readonly ManagerReferenceProject[]
  onDecide: DecideAction
}) {
  switch (message.kind) {
    case 'user':
      return (
        <div data-slot="manager-user" className="flex flex-col items-end gap-2">
          {message.text ? (
            <p className="max-w-[80%] rounded-xl bg-muted px-4 py-2.5 text-sm break-words whitespace-pre-wrap">{message.text}</p>
          ) : null}
          {message.attachments ? <UserAttachments managerId={origin.id} attachments={message.attachments} /> : null}
        </div>
      )
    case 'assistant':
      return <AssistantMessage message={message} origin={origin} projects={projects} answerOnCard={answerOnCard} />
    case 'action':
      return <ActionCard message={message} onDecide={onDecide} />
    case 'notice':
      return <p data-slot="manager-notice" className="text-center text-xs text-muted-foreground">{message.text}</p>
  }
})

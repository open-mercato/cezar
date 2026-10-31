import { BellRingIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { memo, useContext, createContext, useEffect, useState, useMemo, type ComponentProps } from 'react'
import { Link } from 'react-router'

import { sendManagerMessage } from '@/api/managers'
import { useProjects } from '@/api/queries'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { chipClass } from '@/components/picker-pill'
import {
  ISSUE_LINK_PREFIX,
  managerReferences,
  parseManagerText,
  parseReferenceLink,
  PR_LINK_PREFIX,
  TASK_LINK_PREFIX,
  UNKNOWN_PROJECT,
  type ManagerOrigin,
  type ManagerReferenceProject,
} from '@/lib/managers'
import { cn } from '@/lib/utils'
import { Markdown, TranscriptLink } from '@/routes/task-thread/markdown'
import { AskForm } from '@/routes/task-thread/ask-card'
import { forgetAskSelections } from '@/routes/task-thread/ask-selections'
import type { ManagerAsk, ManagerCommand, ManagerMessage } from '@open-mercato/cezar-api-client'

import { ActionCard, type DecideAction } from './manager-approval'
import { SessionCard, TaskChipLabel, taskPath } from './manager-session-card'

const NO_PROJECTS: readonly ManagerReferenceProject[] = []

const OriginContext = createContext<ManagerOrigin>({ id: '', name: '' })

/** The same bubble the task tables show. Its status comes from the reply's own provider. */
function ForgeReference({ kind, projectId, number }: { kind: 'PR' | 'Issue'; projectId: string; number: number }) {
  const origin = useContext(OriginContext)
  const repoUrl = useProjects().data?.projects.find((project) => project.id === projectId)?.repoUrl
  return (
    <ReferenceChip
      compact
      reference={{ kind, number, ...(repoUrl ? { url: `${repoUrl}/${kind === 'PR' ? 'pull' : 'issues'}/${number}` } : {}) }}
      taskTitle={origin.name}
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
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
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

/** A `CEZ:ASK` card. Answering is just the user's next message, so the composer answers it too. */
function ManagerQuestions({
  managerId,
  messageId,
  ask,
  answer,
}: {
  managerId: string
  messageId: string
  ask: ManagerAsk
  answer: string | undefined
}) {
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const card = useMemo(() => ({ id: messageId, questions: ask.questions }), [messageId, ask])
  useEffect(() => {
    if (answer !== undefined) forgetAskSelections(managerId, card)
  }, [answer, card, managerId])
  if (answer !== undefined) {
    return (
      <div data-slot="manager-ask" data-resolved="true" className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
        <span className="text-soft-foreground">Answered</span>
        <span className="ml-1.5 break-words whitespace-pre-line text-foreground">{answer}</span>
      </div>
    )
  }
  const send = async (text: string) => {
    setPending(true)
    setError(undefined)
    try {
      await sendManagerMessage(managerId, text)
      return undefined
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Your answer did not reach the manager.'
      setError(message)
      return message
    } finally {
      setPending(false)
    }
  }
  return (
    <div data-slot="manager-ask" data-resolved="false">
      <AskForm
        ask={card}
        ownerId={managerId}
        delivery={{ mode: 'live', isPending, ...(error ? { error } : {}), send }}
        asker="Your decision"
      />
    </div>
  )
}

function AssistantMessage({
  message,
  origin,
  projects,
}: {
  message: Extract<ManagerMessage, { kind: 'assistant' }>
  origin: ManagerOrigin
  projects: readonly ManagerReferenceProject[]
}) {
  const segments = useMemo(
    () => parseManagerText(message.text, message.commands, projects),
    [message.text, message.commands, projects],
  )
  const references = useMemo(() => managerReferences(segments), [segments])
  return (
    <article data-slot="manager-assistant" className="min-w-0">
      {message.turn === 'job' && message.jobName ? (
        <p className="mb-1 text-xs font-medium text-soft-foreground">Job: {message.jobName}</p>
      ) : null}
      {message.turn === 'watch' ? <p className="mb-1 text-xs font-medium text-soft-foreground">Watch check</p> : null}
      {message.important ? (
        <p data-slot="manager-important" className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <BellRingIcon aria-hidden="true" className="size-3.5 text-pending-strong" />
          {message.headline ?? 'Important'}
        </p>
      ) : null}
      <CommandsRow commands={message.commands} />
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
          <ManagerQuestions managerId={origin.id} messageId={message.id} ask={message.ask} answer={message.askAnswer} />
        </div>
      ) : null}
      {message.stopped ? <p className="mt-1 text-sm text-muted-foreground italic">Response stopped.</p> : null}
      {message.error ? (
        <p role="alert" className="mt-1 flex items-start gap-1.5 text-sm text-danger">
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {message.error}
        </p>
      ) : null}
    </article>
  )
}

/** One chat row. Memoized: a streaming reply re-renders only the message that grew. */
export const ManagerMessageRow = memo(function ManagerMessageRow({
  message,
  origin,
  onDecide,
  projects = NO_PROJECTS,
}: {
  message: ManagerMessage
  origin: ManagerOrigin
  /** Connected projects: what a bare `#12` or a GitHub URL resolves against. */
  projects?: readonly ManagerReferenceProject[]
  onDecide: DecideAction
}) {
  switch (message.kind) {
    case 'user':
      return (
        <div data-slot="manager-user" className="flex justify-end">
          <p className="max-w-[80%] rounded-xl bg-muted px-4 py-2.5 text-sm break-words whitespace-pre-wrap">{message.text}</p>
        </div>
      )
    case 'assistant':
      return <AssistantMessage message={message} origin={origin} projects={projects} />
    case 'action':
      return <ActionCard message={message} onDecide={onDecide} />
    case 'notice':
      return <p data-slot="manager-notice" className="text-center text-xs text-soft-foreground">{message.text}</p>
  }
})

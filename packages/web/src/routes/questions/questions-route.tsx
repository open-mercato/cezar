import { useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon, MessageCircleQuestionIcon, SquareTerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router'

import { ApiError, putWorkspaceUiState } from '@/api/client'
import { useManagers } from '@/api/managers'
import { useHealth, useProjects, workspaceQueryKeys } from '@/api/queries'
import {
  answerQuestion,
  pauseDismiss,
  questionKeys,
  resumeDismiss,
  resumePausedDismissals,
  scheduleDismiss,
  settleQuestion,
  undoDismiss,
  useLiveQuestionCount,
  usePendingDismissals,
  useQuestions,
  visibleOpen,
  type PendingDismissal,
} from '@/api/questions'
import { CacheStatusChip } from '@/components/cache-status'
import { CenteredState } from '@/components/centered-state'
import { IntegerStepper } from '@/components/integer-stepper'
import { LoadingState } from '@/components/loading-state'
import { Segmented } from '@/components/segmented'
import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import { DecisionSourceList } from '@/routes/manager/decision-sources'
import { ManagerAvatar } from '@/routes/manager/manager-avatar'
import { ManagerAskText, ManagerProjectsContext, ManagerReferenceText } from '@/routes/manager/manager-reference'
import { taskPath } from '@/routes/manager/manager-session-card'
import { AskForm } from '@/routes/task-thread/ask-card'

import { StaleNote } from './question-states'
import {
  parseQuestionKey,
  QUESTIONS_OLDER_DEFAULT_DAYS,
  type ManagerAsk,
  type ManagerSummary,
  type QuestionClosed,
  type QuestionItem,
  type QuestionSource,
  type WorkspaceUiState,
} from '@open-mercato/cezar-api-client'

/**
 * The Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`, design page § 01–02): every
 * open question from managers and tasks, grouped by source, answered in place.
 */

type Filter = 'all' | 'manager' | 'task'

const sourceKey = (source: QuestionSource) => (source.kind === 'manager' ? `manager:${source.managerId}` : `task:${source.projectId}/${source.runId}`)

const firstHeader = (item: QuestionItem) => item.questions[0]?.header ?? 'Question'

/** A card's first option, by its key (`CSS.escape` is not everywhere this runs). */
const firstOption = (key: string) =>
  document.querySelector<HTMLElement>(`[data-question-key="${key.replace(/["\\]/g, '\\$&')}"] [aria-pressed]`)

/** Where the card lives: the chat's `#decision-<id>` anchor, or the task thread's open ask. */
export function questionContextHref(item: Pick<QuestionItem, 'key' | 'source'>): string {
  const key = parseQuestionKey(item.key)
  if (key?.kind === 'manager') return `/manager/${encodeURIComponent(key.managerId)}#decision-${encodeURIComponent(key.messageId)}`
  if (item.source.kind === 'task') return `${taskPath(item.source.projectId, item.source.runId)}/chat#ask`
  return item.source.kind === 'manager' ? `/manager/${encodeURIComponent(item.source.managerId)}` : '/'
}

function sourceHref(source: QuestionSource): string {
  return source.kind === 'manager' ? `/manager/${encodeURIComponent(source.managerId)}` : `${taskPath(source.projectId, source.runId)}/chat`
}

/** Stale ones last, then oldest first: the group reads in the order it was asked (design § 04). */
function sortGroup(items: readonly QuestionItem[]): QuestionItem[] {
  return [...items].sort((a, b) => Number(Boolean(a.stale)) - Number(Boolean(b.stale)) || Date.parse(a.askedAt) - Date.parse(b.askedAt))
}

export interface QuestionGroup {
  key: string
  source: QuestionSource
  items: QuestionItem[]
}

/** One group per source, the group with the newest question first. */
export function groupQuestions(items: readonly QuestionItem[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>()
  for (const item of items) {
    const key = sourceKey(item.source)
    const group = groups.get(key) ?? { key, source: item.source, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  const newest = (group: QuestionGroup) => Math.max(...group.items.map((item) => Date.parse(item.askedAt) || 0))
  return [...groups.values()].map((group) => ({ ...group, items: sortGroup(group.items) })).sort((a, b) => newest(b) - newest(a))
}

const REASON_LABEL: Record<QuestionClosed['reason'], string> = {
  answered: 'Answered',
  dismissed: 'Dismissed',
  replaced: 'Replaced',
  retracted: 'Withdrawn',
  expired: 'Expired',
  ended: 'Task ended',
}

/** The Closed row's pill, as text (reasons are never colour alone, design § E). */
export function closedLabel(closed: QuestionClosed, managerName?: (id: string) => string | undefined): string {
  if (closed.reason === 'answered' && closed.answeredIn) {
    if (closed.answeredIn.startsWith('task:')) return 'Answered in the task'
    const name = managerName?.(closed.answeredIn.slice('manager:'.length))
    return name ? `Answered in ${name}’s chat` : 'Answered in the manager’s chat'
  }
  return REASON_LABEL[closed.reason]
}

function summaryLine(open: readonly QuestionItem[]): string {
  const live = open.filter((item) => !item.older)
  if (live.length === 0) return 'Nothing waiting on you'
  const managers = new Set(live.filter((item) => item.source.kind === 'manager').map((item) => sourceKey(item.source))).size
  const tasks = new Set(live.filter((item) => item.source.kind === 'task').map((item) => sourceKey(item.source))).size
  const from = [
    managers ? `${managers} ${managers === 1 ? 'manager' : 'managers'}` : '',
    tasks ? `${tasks} ${tasks === 1 ? 'task' : 'tasks'}` : '',
  ].filter(Boolean).join(' and ')
  return `${live.length} ${live.length === 1 ? 'question' : 'questions'} waiting, from ${from}`
}

/** `/manager/questions`, or `/questions` with managers off. */
export function QuestionsRoute() {
  const health = useHealth()
  const managersOn = health.data?.capabilities.managers === true
  const query = useQuestions()
  const managers = useManagers(managersOn)
  const pending = usePendingDismissals()
  const queryClient = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [olderOpen, setOlderOpen] = useState(false)
  const [closedOpen, setClosedOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const now = useNow(60_000)

  const open = useMemo(() => visibleOpen(query.data, pending), [query.data, pending])
  const shown = open.filter((item) => filter === 'all' || item.source.kind === filter)
  const live = shown.filter((item) => !item.older)
  const older = shown.filter((item) => item.older)
  const closed = (query.data?.closed ?? []).filter((item) => filter === 'all' || item.source.kind === filter)
  const groups = useMemo(() => groupQuestions(live), [live])
  const managerById = useCallback((id: string) => managers.data?.managers.find((manager) => manager.id === id), [managers.data])
  const approvals = (managers.data?.managers ?? []).reduce((sum, manager) => sum + manager.pendingActions, 0)

  // When a card leaves, focus goes to the next card's first option, else the heading (design § E).
  const order = useRef<string[]>([])
  order.current = [...groups.flatMap((group) => group.items.map((item) => item.key)), ...(olderOpen ? older.map((item) => item.key) : [])]
  const handOffFocus = useCallback((leaving: string) => {
    const keys = order.current
    const at = keys.indexOf(leaving)
    const next = keys.slice(at + 1).find((key) => key !== leaving) ?? keys.slice(0, Math.max(0, at)).reverse()[0]
    const focusNext = () => {
      const target = next ? firstOption(next) : null
      ;(target ?? heading.current)?.focus({ preventScroll: false })
    }
    setTimeout(focusNext, 0)
  }, [])

  const dismiss = useCallback((item: QuestionItem) => {
    const inside = document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key') === item.key
    scheduleDismiss(queryClient, item.key, firstHeader(item))
    setAnnouncement(`Dismissed «${firstHeader(item)}». Undo available for 6 seconds.`)
    if (inside || document.activeElement === document.body) handOffFocus(item.key)
  }, [queryClient, handOffFocus])

  const answered = useCallback((item: QuestionItem) => {
    setAnnouncement(`Answered «${firstHeader(item)}».`)
    handOffFocus(item.key)
  }, [handOffFocus])

  const olderAfterDays = query.data?.olderAfterDays ?? QUESTIONS_OLDER_DEFAULT_DAYS

  return (
    <div data-route="questions" className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Questions</h1>
          {managersOn && approvals > 0 ? (
            <Link to="/manager/approvals" data-slot="questions-approvals-link" className={CROSS_LINK_CLASS}>
              {approvals} {approvals === 1 ? 'approval' : 'approvals'} waiting<ChevronRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null}
        </div>
        <p data-slot="questions-status" className="text-sm text-muted-foreground">
          {query.data ? summaryLine(open) : query.isError ? 'Questions from your managers and tasks' : 'Loading questions…'}
        </p>
      </header>
      <p aria-live="polite" data-slot="questions-announcer" className="sr-only">{announcement}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          slot="questions-filter"
          label="Show questions from"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'manager', label: 'Managers' },
            { value: 'task', label: 'Tasks' },
          ]}
        />
        <OlderControl days={olderAfterDays} />
      </div>

      <CacheStatusChip queryKey={questionKeys.all} isFetching={query.isFetching} isError={query.isError} className="self-start" />
      {query.isError && !query.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <p>Couldn’t load questions.</p>
          <Button variant="outline" className="max-md:min-h-11" onClick={() => void query.refetch()}>Retry</Button>
        </div>
      ) : null}
      {!query.data && query.isPending ? <LoadingState label="Loading questions…" /> : null}

      {query.data && groups.length === 0 ? (
        <CenteredState
          heading="h2"
          icon={<MessageCircleQuestionIcon aria-hidden="true" />}
          title="No questions waiting"
          subtitle="Questions from your managers and tasks appear here. Answer them in place, or open them where they were asked."
        />
      ) : null}

      {groups.map((group) => (
        <QuestionGroupSection key={group.key} group={group} manager={group.source.kind === 'manager' ? managerById(group.source.managerId) : undefined} now={now} managerById={managerById} onDismiss={dismiss} onAnswered={answered} />
      ))}

      {query.data && older.length > 0 ? (
        <Fold slot="questions-older" label={`Older · ${older.length}`} hint={`Open longer than ${olderAfterDays} ${olderAfterDays === 1 ? 'day' : 'days'}, not counted`} open={olderOpen} onToggle={() => setOlderOpen((value) => !value)}>
          {groupQuestions(older).map((group) => (
            <QuestionGroupSection key={group.key} group={group} manager={group.source.kind === 'manager' ? managerById(group.source.managerId) : undefined} now={now} managerById={managerById} onDismiss={dismiss} onAnswered={answered} />
          ))}
        </Fold>
      ) : null}

      {query.data && closed.length > 0 ? (
        <Fold slot="questions-closed" label={`Closed · ${closed.length}`} hint="Last 7 days" open={closedOpen} onToggle={() => setClosedOpen((value) => !value)}>
          <ul className="flex flex-col gap-2">
            {closed.map((item) => <ClosedRow key={item.key} item={item} now={now} managerById={managerById} />)}
          </ul>
        </Fold>
      ) : null}

      <DismissToasts pending={pending} heading={heading} />
    </div>
  )
}

const CROSS_LINK_CLASS = 'inline-flex min-h-7 items-center gap-1 rounded-full border border-border bg-card px-2.5 text-label font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:min-h-11'

/** The Approvals page's mirror of the header chip. */
export function QuestionsCrossLink() {
  const count = useLiveQuestionCount()
  if (!count) return null
  return (
    <Link to="/manager/questions" data-slot="approvals-questions-link" className={CROSS_LINK_CLASS}>
      {count} {count === 1 ? 'question' : 'questions'} waiting<ChevronRightIcon aria-hidden="true" className="size-3.5" />
    </Link>
  )
}

/** The Older toggle and its days: workspace ui-state `questions.olderAfterDays` (0 = off). */
function OlderControl({ days }: { days: number }) {
  const queryClient = useQueryClient()
  const on = days > 0
  const lastOn = useRef(on ? days : QUESTIONS_OLDER_DEFAULT_DAYS)
  if (on) lastOn.current = days
  const save = async (next: number) => {
    queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, (state) => (state ? { ...state, questions: { ...state.questions, olderAfterDays: next } } : state))
    const state = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
    await putWorkspaceUiState({ questions: { ...state?.questions, olderAfterDays: next } })
    await queryClient.invalidateQueries({ queryKey: questionKeys.all })
  }
  return (
    <div data-slot="questions-older-control" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <label className="flex min-h-7 cursor-pointer items-center gap-2 max-md:min-h-11">
        <input type="checkbox" className="size-4" checked={on} onChange={(event) => void save(event.target.checked ? lastOn.current : 0)} />
        Move to Older after
      </label>
      <IntegerStepper aria-label="Days before a question moves to Older" value={on ? days : lastOn.current} min={1} max={365} disabled={!on} onCommit={(next) => (next === null ? undefined : save(next))} className="w-28" />
      <span aria-hidden="true">days</span>
    </div>
  )
}

function Fold({ slot, label, hint, open, onToggle, children }: { slot: string; label: string; hint: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section data-slot={slot} className="flex flex-col gap-3 border-t border-border pt-3">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-h-9 items-center gap-2 self-start rounded-md px-1 text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:min-h-11">
        <ChevronRightIcon aria-hidden="true" className={cn('size-4 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        {label}
        <span className="font-normal text-muted-foreground">{hint}</span>
      </button>
      {open ? children : null}
    </section>
  )
}

function SourceGlyph({ source, manager }: { source: QuestionSource; manager?: ManagerSummary | undefined }) {
  if (source.kind === 'manager') {
    return manager ? <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-8" sizes="32px" /> : <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-muted"><MessageCircleQuestionIcon className="size-4" /></span>
  }
  return <span aria-hidden="true" data-slot="question-task-glyph" className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card"><SquareTerminalIcon className="size-4 text-muted-foreground" /></span>
}

function QuestionGroupSection({ group, manager, now, managerById, onDismiss, onAnswered }: {
  group: QuestionGroup
  manager?: ManagerSummary | undefined
  now: number
  managerById: (id: string) => ManagerSummary | undefined
  onDismiss: (item: QuestionItem) => void
  onAnswered: (item: QuestionItem) => void
}) {
  const projects = useProjects()
  const { source } = group
  const name = source.kind === 'manager' ? source.name : source.title
  const project = source.kind === 'task' ? projects.data?.projects.find((entry) => entry.id === source.projectId)?.name ?? source.projectId : undefined
  return (
    <section aria-label={name} data-slot="question-group" data-source={source.kind} className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <SourceGlyph source={source} manager={manager} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{name}</h2>
          <p className="truncate text-meta text-muted-foreground">{source.kind === 'manager' ? 'Manager' : `${project} · ${source.status}`}</p>
        </div>
        <Button asChild variant="outline" className="shrink-0 max-md:min-h-11">
          <Link to={sourceHref(source)} aria-label={`${source.kind === 'manager' ? 'Open chat with' : 'Open task'} ${name}`}>{source.kind === 'manager' ? 'Open chat' : 'Open task'}</Link>
        </Button>
      </div>
      {group.items.map((item) => <QuestionCard key={item.key} item={item} now={now} managerById={managerById} onDismiss={onDismiss} onAnswered={onAnswered} />)}
    </section>
  )
}

function QuestionCard({ item, now, managerById, onDismiss, onAnswered }: {
  item: QuestionItem
  now: number
  managerById: (id: string) => ManagerSummary | undefined
  onDismiss: (item: QuestionItem) => void
  onAnswered: (item: QuestionItem) => void
}) {
  const queryClient = useQueryClient()
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const card = useMemo(() => ({ id: item.key, questions: item.questions }), [item.key, item.questions])
  const key = parseQuestionKey(item.key)
  const send = async (text: string) => {
    setPending(true)
    setError(undefined)
    try {
      const closed = await answerQuestion(item.key, text)
      onAnswered(item)
      settleQuestion(queryClient, closed)
      return undefined
    } catch (failure) {
      const message = failure instanceof ApiError && failure.status === 409
        ? 'This question closed before your answer arrived.'
        : failure instanceof Error ? failure.message : 'Your answer was not delivered.'
      setError(message)
      if (failure instanceof ApiError && failure.status === 409) void queryClient.invalidateQueries({ queryKey: questionKeys.all })
      return message
    } finally {
      setPending(false)
    }
  }
  const linked = item.linked
  const linkedManager = linked?.source.kind === 'manager' ? linked.source : undefined
  return (
    <div
      role="group"
      // Named by its headers: each question inside is a group of its own, named by its text.
      aria-label={item.questions.map((question) => question.header).join(', ')}
      data-slot="question-card"
      data-question-key={item.key}
      data-stale={item.stale ? true : undefined}
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
        <time dateTime={item.askedAt} title={new Date(item.askedAt).toLocaleString()}>asked {shortAge(item.askedAt, now) || 'just now'} ago</time>
        {linkedManager && linked ? (
          <Link to={questionContextHref(linked)} data-slot="question-linked" className="rounded-full border border-border px-2 py-px text-micro font-medium hover:text-foreground">
            also in {linkedManager.name}’s chat
          </Link>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="pointer-coarse:min-h-11">
            <Link to={questionContextHref(item)} data-slot="question-open-context">Open in context</Link>
          </Button>
          <Button variant="ghost" size="sm" data-slot="question-dismiss" aria-label={`Dismiss «${firstHeader(item)}»`} className="pointer-coarse:min-h-11" disabled={isPending} onClick={() => onDismiss(item)}>
            Dismiss
          </Button>
        </span>
      </div>
      {item.stale ? <StaleNote detail={item.stale.detail} onDismiss={() => onDismiss(item)} disabled={isPending} /> : null}
      {key?.kind === 'manager' && item.sourceTasks?.length && item.source.kind === 'manager' ? (
        <DecisionSourceList
          sources={item.sourceTasks}
          text={item.questions.map((question) => question.question).join(' ')}
          origin={{ id: key.managerId, name: managerById(key.managerId)?.name ?? item.source.name }}
          decisionId={key.messageId}
          returnHint={false}
        />
      ) : null}
      <div>
        <QuestionText item={item} managerById={managerById} ask={card}>
          <AskForm ask={card} ownerId="questions" delivery={{ mode: 'live', isPending, ...(error ? { error } : {}), send }} asker="Your decision" composerBelow={false} framed={false} />
        </QuestionText>
      </div>
    </div>
  )
}

/** A manager's connected projects, so its card's markers paint as the chat's chips (#2306). */
function useManagerProjects(manager: ManagerSummary | undefined) {
  const registry = useProjects().data?.projects
  return useMemo(
    () => (manager ? (registry ?? []).filter((project) => manager.connectedProjectIds.includes(project.id)) : []),
    [registry, manager],
  )
}

/** A manager's question reads as it does in the chat; a task's card shows its words as written. */
function QuestionText({ item, managerById, ask, children }: {
  item: QuestionItem
  managerById: (id: string) => ManagerSummary | undefined
  ask: Pick<ManagerAsk, 'questions'>
  children: ReactNode
}) {
  const manager = item.source.kind === 'manager' ? managerById(item.source.managerId) : undefined
  const projects = useManagerProjects(manager)
  if (item.source.kind !== 'manager') return children
  return (
    <ManagerProjectsContext.Provider value={projects}>
      <ManagerAskText ask={ask} origin={{ id: item.source.managerId, name: manager?.name ?? item.source.name }}>{children}</ManagerAskText>
    </ManagerProjectsContext.Provider>
  )
}

function ClosedRow({ item, now, managerById }: { item: QuestionItem; now: number; managerById: (id: string) => ManagerSummary | undefined }) {
  const source = item.source
  const manager = source.kind === 'manager' ? managerById(source.managerId) : undefined
  const projects = useManagerProjects(manager)
  const closed = item.closed
  if (!closed) return null
  const label = closedLabel(closed, (id) => managerById(id)?.name)
  const task = source.kind === 'task' ? source : item.sourceTasks?.[0]
  const origin = source.kind === 'manager' ? { id: source.managerId, name: manager?.name ?? source.name } : undefined
  const words = (text: string) => (origin ? <ManagerReferenceText text={text} origin={origin} /> : text)
  return (
    <ManagerProjectsContext.Provider value={projects}>
      <li data-slot="question-closed" data-reason={closed.reason} className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-label text-muted-foreground">
        <span className="flex flex-wrap items-center gap-2">
          <span data-slot="question-closed-reason" className="rounded-full bg-muted px-2 py-px text-micro font-semibold text-foreground">{label}</span>
          <span>{shortAge(closed.at, now) || 'just now'} ago</span>
          <span className="font-medium text-foreground">{source.kind === 'manager' ? source.name : source.title}</span>
        </span>
        {item.questions.map((question, index) => (
          <span key={index} className="break-words"><span className="font-medium">{question.header}</span> <s>{words(question.question)}</s></span>
        ))}
        {closed.answer && closed.reason === 'answered' ? <span className="break-words text-foreground">{words(closed.answer)}</span> : null}
        {closed.detail ? <span className="break-words">{closed.detail}</span> : null}
        <span className="flex flex-wrap gap-x-3">
          {task ? <Link to={`${taskPath(task.projectId, task.runId)}/chat`} className="font-medium text-foreground underline underline-offset-4">Open task</Link> : null}
          {source.kind === 'manager' ? <Link to={questionContextHref(item)} className="font-medium text-foreground underline underline-offset-4">Open in chat</Link> : null}
        </span>
      </li>
    </ManagerProjectsContext.Provider>
  )
}

/**
 * The undo toasts (design § E): Undo is reachable by keyboard, and the timeout pauses while focus
 * is inside. A dismissal that failed stays here with Retry until the user decides.
 */
function DismissToasts({ pending, heading }: { pending: readonly PendingDismissal[]; heading: RefObject<HTMLHeadingElement | null> }) {
  const queryClient = useQueryClient()
  useEffect(() => resumePausedDismissals, [])
  if (pending.length === 0) return null
  return (
    <div data-slot="questions-toasts" className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4">
      {pending.map((entry) => (
        <div
          key={entry.key}
          data-slot="questions-toast"
          data-key={entry.key}
          onFocus={() => pauseDismiss(entry.key)}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeDismiss(entry.key) }}
          className="pointer-events-auto flex max-w-md flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
        >
          {entry.error ? (
            <>
              <span role="alert" className="min-w-0 flex-1">Couldn’t dismiss «{entry.label}»: {entry.error}</span>
              <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => scheduleDismiss(queryClient, entry.key, entry.label)}>Retry</Button>
              <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => undoDismiss(entry.key)}>Keep it</Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">Dismissed «{entry.label}»</span>
              <Button
                size="sm"
                variant="outline"
                data-slot="questions-undo"
                className="pointer-coarse:min-h-11"
                onClick={() => {
                  undoDismiss(entry.key)
                  // The card is back: hand it the focus the toast held.
                  setTimeout(() => {
                    const back = firstOption(entry.key)
                    ;(back ?? heading.current)?.focus()
                  }, 0)
                }}
              >
                Undo
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

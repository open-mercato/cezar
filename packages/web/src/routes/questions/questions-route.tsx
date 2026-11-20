import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ChevronRightIcon, MessageCircleQuestionIcon, PauseIcon, SquareTerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import { ApiError, putWorkspaceUiState } from '@/api/client'
import { managerKeys, refreshManagerChat, useManagers } from '@/api/managers'
import { useHealth, useProjects, workspaceQueryKeys } from '@/api/queries'
import {
  answerQuestion,
  markAnswering,
  pauseDismiss,
  questionKeys,
  resumeDismiss,
  resumePausedDismissals,
  scheduleDismiss,
  settleQuestion,
  undoDismiss,
  useAnsweringQuestions,
  useInactiveManagerIds,
  useInactiveQuestionCount,
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
import { useLinger, type LeaveMode } from '@/routes/manager/approvals-linger'
import { DecisionSourceList } from '@/routes/manager/decision-sources'
import { LingerCollapse } from '@/routes/manager/linger-collapse'
import { ManagerAvatar } from '@/routes/manager/manager-avatar'
import { useActivityConfirm } from '@/routes/manager/manager-activity'
import { ManagerAskText, ManagerProjectsContext, ManagerReferenceText } from '@/routes/manager/manager-reference'
import { taskPath } from '@/routes/manager/manager-session-card'
import { AskForm } from '@/routes/task-thread/ask-card'

import { DismissingNote, StaleNote } from './question-states'
import {
  parseQuestionKey,
  QUESTIONS_OLDER_DEFAULT_DAYS,
  type ManagerAsk,
  type ManagerListResponse,
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

/** Where focus lands on a card: its first option, else its outcome or Undo note. */
const cardFocusTarget = (key: string) => {
  const card = `[data-question-key="${key.replace(/["\\]/g, '\\$&')}"]`
  return firstOption(key) ?? document.querySelector<HTMLElement>(`${card} [data-slot="question-outcome"], ${card} [data-slot="question-dismissing-wrap"]`)
}

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

/**
 * A card that finished while this page showed it stays in place, locked, then lingers 30 s like a
 * decided approval (#2316). Page-scoped on purpose: coming back shows it gone, under Closed.
 */
type Outcome =
  | { kind: 'sending' | 'answered'; text: string }
  /** Closed some other way: a dismissal that landed, or the system (replaced, expired, …). */
  | { kind: 'closed'; note?: string }
interface Finished {
  item: QuestionItem
  outcome: Outcome
  closed?: QuestionClosed
  /** When this mount saw it finish; unset while the answer is still on its way. */
  finishedAt?: number
}

/** The sidebar's "Waiting for N answers" drops on the click; the next list read corrects it. */
function dropManagerQuestion(queryClient: ReturnType<typeof useQueryClient>, item: QuestionItem): void {
  if (item.source.kind !== 'manager') return
  const id = item.source.managerId
  queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) => list && {
    ...list,
    managers: list.managers.map((row) => (row.id === id ? { ...row, pendingQuestions: Math.max(0, row.pendingQuestions - 1) } : row)),
  })
}

const ANSWER_SHOWN_MAX = 140

/** "Design: Yes" reads back as "Yes" on a one-question card; long free text is cut. */
export function answerShown(item: Pick<QuestionItem, 'questions'>, text: string): string {
  const only = item.questions.length === 1 ? item.questions[0] : undefined
  const words = only && text.startsWith(`${only.header}: `) ? text.slice(only.header.length + 2) : text.split('\n').join(' · ')
  return words.length > ANSWER_SHOWN_MAX ? `${words.slice(0, ANSWER_SHOWN_MAX - 1).trimEnd()}…` : words
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

/** The header count matches the sidebar badge: an inactive manager's cards are not counted (spec 2026-11-19-manager-deactivate). */
function summaryLine(open: readonly QuestionItem[], inactive: ReadonlySet<string>): string {
  const live = open.filter((item) => !item.older && !(item.source.kind === 'manager' && inactive.has(item.source.managerId)))
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
  const inFlight = useAnsweringQuestions()
  const queryClient = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [olderOpen, setOlderOpen] = useState(false)
  const [closedOpen, setClosedOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const now = useNow(60_000)

  const [finished, setFinished] = useState<Finished[]>([])
  // A card that leaves the open list while shown (answered elsewhere, replaced, expired, a
  // dismissal that landed) is kept with its reason; set during render so it never blinks out.
  const [seen, setSeen] = useState(query.data)
  if (query.data !== seen) {
    setSeen(query.data)
    const still = new Set((query.data?.open ?? []).map((item) => item.key))
    const left = query.data ? (seen?.open ?? []).filter((item) => !still.has(item.key)) : []
    if (left.length > 0) {
      const at = Date.now()
      setFinished((rows) => [...rows, ...left.filter((item) => !rows.some((row) => row.item.key === item.key)).map((item) => ({ item, outcome: { kind: 'closed' as const }, finishedAt: at }))])
    }
  }
  const finishedByKey = new Map(finished.map((row) => [row.item.key, row]))
  const dismissing = new Map(pending.filter((entry) => !entry.error).map((entry) => [entry.key, entry]))

  // What counts: open, not inside an undo window, not answered or finished here.
  const open = useMemo(() => visibleOpen(query.data, pending).filter((item) => !inFlight.has(item.key) && !finished.some((row) => row.item.key === item.key)), [query.data, pending, inFlight, finished])
  // What shows: the open list, with a finished card held where it was.
  const displayed = [...(query.data?.open ?? []).filter((item) => !finishedByKey.has(item.key)), ...finished.map((row) => row.item)]
  const shown = displayed.filter((item) => filter === 'all' || item.source.kind === filter)
  const live = shown.filter((item) => !item.older)
  const older = shown.filter((item) => item.older)
  const closed = (query.data?.closed ?? []).filter((item) => filter === 'all' || item.source.kind === filter)
  const groups = groupQuestions(live)
  const managerById = useCallback((id: string) => managers.data?.managers.find((manager) => manager.id === id), [managers.data])
  const approvals = (managers.data?.managers ?? []).reduce((sum, manager) => sum + manager.pendingActions, 0)
  const fromInactive = useInactiveQuestionCount()
  const inactiveIds = useInactiveManagerIds()

  // When a lingering card leaves, focus goes to its nearest surviving neighbour, next then previous,
  // else the heading (design § E).
  const order = useRef<string[]>([])
  order.current = [...groups.flatMap((group) => group.items.map((item) => item.key)), ...(olderOpen ? older.map((item) => item.key) : [])]
  const handOffFocus = useCallback((leaving: string) => {
    // Read the order now: by the time the timer fires the leaving card is no longer in it.
    const keys = order.current
    const at = keys.indexOf(leaving)
    const candidates = at < 0 ? keys : [...keys.slice(at + 1), ...keys.slice(0, at).reverse()]
    setTimeout(() => {
      const target = candidates.filter((key) => key !== leaving).map(cardFocusTarget).find(Boolean)
      ;(target ?? heading.current)?.focus({ preventScroll: true })
    }, 0)
  }, [])

  const remove = useCallback((keys: ReadonlySet<string>) => {
    const holder = document.activeElement?.closest('[data-question-key]')?.getAttribute('data-question-key')
    if (holder && keys.has(holder)) handOffFocus(holder)
    setFinished((rows) => rows.filter((row) => !keys.has(row.item.key)))
  }, [handOffFocus])
  const list = useRef<HTMLDivElement>(null)
  const leaving = useLinger(finished.map((row) => ({ key: row.item.key, ...(row.finishedAt === undefined ? {} : { finishedAt: row.finishedAt }) })), remove, list)

  const dismiss = useCallback((item: QuestionItem) => {
    scheduleDismiss(queryClient, item.key, firstHeader(item))
    dropManagerQuestion(queryClient, item)
    setAnnouncement(`Dismissed «${firstHeader(item)}». Undo available for 6 seconds.`)
  }, [queryClient])

  const undo = useCallback((item: QuestionItem) => {
    undoDismiss(item.key)
    setFinished((rows) => rows.filter((row) => row.item.key !== item.key))
    void queryClient.invalidateQueries({ queryKey: managerKeys.list })
    setAnnouncement(`Kept «${firstHeader(item)}».`)
    setTimeout(() => {
      const back = firstOption(item.key)
      ;(back ?? heading.current)?.focus()
    }, 0)
  }, [queryClient])

  const answer = useMemo<AnswerHandlers>(() => ({
    start: (item, text) => {
      markAnswering(item.key, true)
      dropManagerQuestion(queryClient, item)
      setFinished((rows) => [...rows.filter((row) => row.item.key !== item.key), { item, outcome: { kind: 'sending', text } }])
    },
    done: (item, text, settled) => {
      const at = Date.now()
      setFinished((rows) => [...rows.filter((row) => row.item.key !== item.key), { item, outcome: { kind: 'answered', text }, ...(settled.closed ? { closed: settled.closed } : {}), finishedAt: at }])
      settleQuestion(queryClient, settled)
      markAnswering(item.key, false)
      setAnnouncement(`Answered «${firstHeader(item)}».`)
      void queryClient.invalidateQueries({ queryKey: managerKeys.list })
      // The chat's copy of the card turns answered too, without waiting for its next frame.
      if (item.source.kind === 'manager') void refreshManagerChat(queryClient, item.source.managerId)
    },
    failed: (item, message, closedMeanwhile) => {
      markAnswering(item.key, false)
      setAnnouncement(closedMeanwhile ? `«${firstHeader(item)}» closed before your answer arrived.` : `Your answer to «${firstHeader(item)}» was not delivered: ${message}`)
      void queryClient.invalidateQueries({ queryKey: managerKeys.list })
      // Never dropped silently: a delivery that failed hands the card back with its error.
      setFinished((rows) => [
        ...rows.filter((row) => row.item.key !== item.key),
        ...(closedMeanwhile ? [{ item, outcome: { kind: 'closed' as const, note: message }, finishedAt: Date.now() }] : []),
      ])
    },
  }), [queryClient])

  const cardState = (item: QuestionItem): CardState => {
    const row = finishedByKey.get(item.key)
    const entry = dismissing.get(item.key)
    // The live counts can take a card off the list while its dismissal is pending (questions.ts,
    // applyQuestionCounts): it still shows Undo until the dismissal lands. A card closed for
    // another reason is in the closed list already and shows why.
    const closedElsewhere = query.data?.closed.some((closed) => closed.key === item.key) === true
    if (row && !(entry && row.outcome.kind === 'closed' && !row.closed && !closedElsewhere)) {
      const closed = row.closed ?? query.data?.closed.find((entry) => entry.key === item.key)?.closed
      return { kind: 'finished', row: closed ? { ...row, closed } : row, fading: leaving.has(item.key), leaving: leaving.get(item.key) }
    }
    return entry ? { kind: 'dismissing', label: entry.label } : { kind: 'open' }
  }
  const groupProps = { now, managerById, cardState, onDismiss: dismiss, onUndo: undo, answer }

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
          {fromInactive > 0 ? (
            <span data-slot="questions-inactive-note" className="text-meta text-muted-foreground md:ml-auto">+{fromInactive} from inactive managers, not counted</span>
          ) : null}
        </div>
        <p data-slot="questions-status" className="text-sm text-muted-foreground">
          {query.data ? summaryLine(open, inactiveIds) : query.isError ? 'Questions from your managers and tasks' : 'Loading questions…'}
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

      {/* The cards region: the pointer or focus in here holds a lingering card back (useLinger). */}
      <div ref={list} data-slot="questions-list" className="contents">
        {groups.map((group) => (
          <QuestionGroupSection key={group.key} group={group} manager={group.source.kind === 'manager' ? managerById(group.source.managerId) : undefined} {...groupProps} />
        ))}

        {query.data && older.length > 0 ? (
          <Fold slot="questions-older" label={`Older · ${older.length}`} hint={`Open longer than ${olderAfterDays} ${olderAfterDays === 1 ? 'day' : 'days'}, not counted`} open={olderOpen} onToggle={() => setOlderOpen((value) => !value)}>
            {groupQuestions(older).map((group) => (
              <QuestionGroupSection key={group.key} group={group} manager={group.source.kind === 'manager' ? managerById(group.source.managerId) : undefined} {...groupProps} />
            ))}
          </Fold>
        ) : null}
      </div>

      {query.data && closed.length > 0 ? (
        <Fold slot="questions-closed" label={`Closed · ${closed.length}`} hint="Last 7 days" open={closedOpen} onToggle={() => setClosedOpen((value) => !value)}>
          <ul className="flex flex-col gap-2">
            {closed.map((item) => <ClosedRow key={item.key} item={item} now={now} managerById={managerById} />)}
          </ul>
        </Fold>
      ) : null}

      <DismissToasts pending={pending} />
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
    return manager ? <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={manager.inactive !== undefined} className="size-8" sizes="32px" /> : <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-muted"><MessageCircleQuestionIcon className="size-4" /></span>
  }
  return <span aria-hidden="true" data-slot="question-task-glyph" className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card"><SquareTerminalIcon className="size-4 text-muted-foreground" /></span>
}

type CardState =
  | { kind: 'open' }
  | { kind: 'dismissing'; label: string }
  | { kind: 'finished'; row: Finished; fading: boolean; leaving: LeaveMode | undefined }

interface AnswerHandlers {
  start: (item: QuestionItem, text: string) => void
  done: (item: QuestionItem, text: string, settled: QuestionItem) => void
  /** `closedMeanwhile`: the server says it closed first (409), so the card finishes with `message`. */
  failed: (item: QuestionItem, message: string, closedMeanwhile: boolean) => void
}

interface CardProps {
  now: number
  managerById: (id: string) => ManagerSummary | undefined
  cardState: (item: QuestionItem) => CardState
  onDismiss: (item: QuestionItem) => void
  onUndo: (item: QuestionItem) => void
  answer: AnswerHandlers
}

function QuestionGroupSection({ group, manager, ...card }: CardProps & { group: QuestionGroup; manager?: ManagerSummary | undefined }) {
  const projects = useProjects()
  const { source } = group
  const name = source.kind === 'manager' ? source.name : source.title
  const project = source.kind === 'task' ? projects.data?.projects.find((entry) => entry.id === source.projectId)?.name ?? source.projectId : undefined
  const inactive = manager?.inactive !== undefined
  // Its last card leaving takes the heading along, so nothing below jumps when the group goes.
  const modes = group.items.map((item) => { const state = card.cardState(item); return state.kind === 'finished' ? state.leaving : undefined })
  const leaving = modes.every((mode) => mode !== undefined) ? modes[0] : undefined
  return (
    <LingerCollapse leaving={leaving}>
      <section aria-label={name} data-slot="question-group" data-source={source.kind} data-inactive={inactive || undefined} className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <SourceGlyph source={source} manager={manager} />
          <div className="min-w-0 flex-1">
            <h2 className={cn('truncate font-semibold', inactive && 'text-muted-foreground')}>{name}</h2>
            <p className="truncate text-meta text-muted-foreground">{source.kind === 'manager' ? (inactive ? 'Manager · inactive' : 'Manager') : `${project} · ${source.status}`}</p>
          </div>
          <Button asChild variant="outline" className="shrink-0 max-md:min-h-11">
            <Link to={sourceHref(source)} aria-label={`${source.kind === 'manager' ? 'Open chat with' : 'Open task'} ${name}`}>{source.kind === 'manager' ? 'Open chat' : 'Open task'}</Link>
          </Button>
        </div>
        {group.items.map((item) => {
          const state = card.cardState(item)
          return (
            <LingerCollapse key={item.key} lingerKey={item.key} leaving={state.kind === 'finished' ? state.leaving : undefined}>
              <QuestionCard item={item} state={state} {...card} />
            </LingerCollapse>
          )
        })}
      </section>
    </LingerCollapse>
  )
}

function QuestionCard({ item, state, now, managerById, onDismiss, onUndo, answer }: CardProps & { item: QuestionItem; state: CardState }) {
  const queryClient = useQueryClient()
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const card = useMemo(() => ({ id: item.key, questions: item.questions }), [item.key, item.questions])
  const key = parseQuestionKey(item.key)
  const root = useRef<HTMLDivElement>(null)
  // Focus was inside when the chips or the Undo it sat on unmounted: hand it to what replaced them.
  const focusedInside = useRef(false)
  // The chip a one-tap answer was sent from, by position: the chips remount, and Enter on it retries.
  const sentFrom = useRef(-1)
  const phase = state.kind === 'finished' ? `finished:${state.row.outcome.kind}` : state.kind
  useEffect(() => {
    const from = sentFrom.current
    if (state.kind === 'open') sentFrom.current = -1
    if (!focusedInside.current || (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected)) return
    // Back to answerable (a failed delivery, an Undo): the pick it was sent with, else the first chip.
    const target = state.kind === 'open'
      ? root.current?.querySelectorAll<HTMLElement>('[aria-pressed]')[from]
        ?? root.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? root.current?.querySelector<HTMLElement>('[aria-pressed]')
      : root.current?.querySelector<HTMLElement>('[data-slot="question-outcome"], [data-slot="question-dismissing-wrap"]')
    target?.focus({ preventScroll: true })
  }, [phase])
  // An inactive manager's answer is a chat turn: confirm waking it first (spec 2026-11-19-manager-deactivate).
  const owner = item.source.kind === 'manager' ? managerById(item.source.managerId) : undefined
  const inactive = owner?.inactive !== undefined
  const { confirmActivity, dialog } = useActivityConfirm()
  const send = async (text: string) => {
    // Read before the inactive-manager confirm: its dialog takes the focus.
    const chips = [...(root.current?.querySelectorAll<HTMLElement>('[aria-pressed]') ?? [])]
    const from = chips.indexOf(document.activeElement as HTMLElement)
    if (owner && inactive && !(await confirmActivity({ kind: 'answer', manager: owner, answer: text }))) {
      const message = `Not sent: ${owner.name} is still inactive. Dismiss closes the question without waking it.`
      setError(message)
      return message
    }
    setPending(true)
    setError(undefined)
    sentFrom.current = from
    answer.start(item, text)
    try {
      answer.done(item, text, await answerQuestion(item.key, text, inactive ? { reactivate: true } : undefined))
      return undefined
    } catch (failure) {
      const gone = failure instanceof ApiError && failure.status === 409
      const message = gone
        ? 'This question closed before your answer arrived.'
        : failure instanceof Error ? failure.message : 'Your answer was not delivered.'
      setError(message)
      answer.failed(item, message, gone)
      if (gone) void queryClient.invalidateQueries({ queryKey: questionKeys.all })
      return message
    } finally {
      setPending(false)
    }
  }
  const linked = item.linked
  const linkedManager = linked?.source.kind === 'manager' ? linked.source : undefined
  const finished = state.kind === 'finished' ? state.row : undefined
  const fading = state.kind === 'finished' && state.fading
  return (
    <div
      ref={root}
      role="group"
      // Named by its headers: each question inside is a group of its own, named by its text.
      aria-label={item.questions.map((question) => question.header).join(', ')}
      data-slot="question-card"
      data-question-key={item.key}
      data-stale={item.stale ? true : undefined}
      data-state={state.kind}
      data-inactive={inactive || undefined}
      data-lingering={finished?.finishedAt === undefined ? undefined : fading ? 'leaving' : 'shown'}
      onFocus={() => { focusedInside.current = true }}
      onBlur={(event) => {
        // A focused node that unmounts blurs with no target: that focus is still "inside".
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) focusedInside.current = false
      }}
      className={cn(
        'flex flex-col gap-2.5 rounded-xl border border-border p-3.5',
        state.kind !== 'open' ? 'bg-card/60' : inactive ? 'bg-card-2' : 'bg-card',
      )}
    >
      {inactive ? (
        <p data-slot="question-inactive-flag" className="inline-flex items-center gap-1.5 self-start rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
          <PauseIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Manager inactive — answering reactivates it; dismissing does not
        </p>
      ) : null}
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
          {state.kind === 'open' ? (
            <Button variant="ghost" size="sm" data-slot="question-dismiss" aria-label={`Dismiss «${firstHeader(item)}»`} className="pointer-coarse:min-h-11" disabled={isPending} onClick={() => onDismiss(item)}>
              Dismiss
            </Button>
          ) : null}
        </span>
      </div>
      {item.stale && state.kind === 'open' ? <StaleNote detail={item.stale.detail} onDismiss={() => onDismiss(item)} disabled={isPending} /> : null}
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
          {state.kind === 'open' ? (
            <AskForm ask={card} ownerId="questions" delivery={{ mode: 'live', isPending, ...(error ? { error } : {}), send }} asker="Your decision" composerBelow={false} framed={false} />
          ) : (
            <LockedQuestion item={item}>
              {state.kind === 'dismissing' ? (
                <div
                  tabIndex={-1}
                  data-slot="question-dismissing-wrap"
                  className="rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  // The undo window pauses while Undo has focus, as the toast's did (design § E).
                  onFocus={(event) => { if (event.target !== event.currentTarget) pauseDismiss(item.key) }}
                  onBlur={(event) => { if (event.target !== event.currentTarget && !event.currentTarget.contains(event.relatedTarget as Node | null)) resumeDismiss(item.key) }}
                >
                  <DismissingNote label={state.label} onUndo={() => onUndo(item)} />
                </div>
              ) : <QuestionOutcome item={item} row={state.row} managerById={managerById} />}
            </LockedQuestion>
          )}
        </QuestionText>
      </div>
      {dialog}
    </div>
  )
}

/** The asked words, read-only: the chips are gone once the card is answered, dismissed or closed. */
function LockedQuestion({ item, children }: { item: QuestionItem; children: ReactNode }) {
  const origin = item.source.kind === 'manager' ? { id: item.source.managerId, name: item.source.name } : undefined
  return (
    <div className="flex flex-col gap-2">
      {item.questions.map((question, index) => (
        <p key={index} className="break-words text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{question.header}</span>{' '}
          {origin ? <ManagerReferenceText text={question.question} origin={origin} /> : question.question}
        </p>
      ))}
      {children}
    </div>
  )
}

/** What happened to a finished card, in place: the answer and where it went, or why it closed. */
function QuestionOutcome({ item, row, managerById }: { item: QuestionItem; row: Finished; managerById: (id: string) => ManagerSummary | undefined }) {
  const { outcome, closed } = row
  const target = item.source.kind === 'manager' ? managerById(item.source.managerId)?.name ?? item.source.name : item.source.title
  const base = 'flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-label text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
  if (outcome.kind !== 'closed') {
    const delivered = outcome.kind === 'answered'
    return (
      <div tabIndex={-1} data-slot="question-outcome" data-outcome={outcome.kind} className={base}>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 flex-1 break-words text-foreground" title={outcome.text}>
            <span className="font-medium">Answered:</span> {answerShown(item, outcome.text)}
          </span>
          {delivered ? <CheckIcon role="img" aria-label="Delivered" data-slot="question-delivered" className="size-3.5 shrink-0 self-center text-success" /> : null}
        </span>
        <span data-slot="question-sent-to">{delivered ? `Sent to ${target}` : `Sending to ${target}…`}</span>
      </div>
    )
  }
  const label = closed ? closedLabel(closed, (id) => managerById(id)?.name) : 'Closed'
  const detail = outcome.note
    ?? closed?.detail
    ?? (closed?.reason === 'replaced' ? `A newer “${firstHeader(item)}” question replaced this one.` : undefined)
  return (
    <div tabIndex={-1} data-slot="question-outcome" data-outcome="closed" data-reason={closed?.reason} className={cn(base, 'border-dashed')}>
      <span data-slot="question-outcome-reason" className="font-medium text-soft-foreground">{label}</span>
      {closed?.reason === 'answered' && closed.answer ? <span className="break-words text-foreground" title={closed.answer}>{answerShown(item, closed.answer)}</span> : null}
      {detail ? <span className="break-words">{detail}</span> : null}
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
 * A dismissal that failed stays here with Retry until the user decides; one inside its undo window
 * shows its Undo on the card itself.
 */
function DismissToasts({ pending: all }: { pending: readonly PendingDismissal[] }) {
  const queryClient = useQueryClient()
  // Leaving the page with focus on a card's Undo fires no blur: restart those clocks.
  useEffect(() => resumePausedDismissals, [])
  const pending = all.filter((entry) => entry.error)
  if (pending.length === 0) return null
  return (
    <div data-slot="questions-toasts" className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4">
      {pending.map((entry) => (
        <div
          key={entry.key}
          data-slot="questions-toast"
          data-key={entry.key}
          className="pointer-events-auto flex max-w-md flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
        >
          <span role="alert" className="min-w-0 flex-1">Couldn’t dismiss «{entry.label}»: {entry.error}</span>
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => scheduleDismiss(queryClient, entry.key, entry.label)}>Retry</Button>
          <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => undoDismiss(entry.key)}>Keep it</Button>
        </div>
      ))}
    </div>
  )
}

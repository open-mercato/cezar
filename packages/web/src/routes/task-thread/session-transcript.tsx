import { createContext, memo, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'

import type { ApiRun, RunArtifact, UiMessageItem, UiReasoningItem, UiToolItem } from '@open-mercato/cezar-api-client'
import type { MessageQuote } from '@/lib/message-quotes'
import { sameData } from '@/lib/same-data'
import type { RunHistoryState } from '@/api/run-history'
import { highlightJumpTarget, untilFrame } from '@/components/my-messages/use-my-messages-nav'
import { toast } from '@/components/ui/toaster'

import { byNewest } from '../task-assets/assets-model'
import { cardableArtifacts, ThreadArtifactCards } from '../task-assets/thread-artifact-cards'
import { groupThreadItems, type ThreadBlock } from './thread-groups'
import {
  AssistantMessage,
  ContextGroup,
  ImageItem,
  NoteLine,
  AgentUpdateRequiredCard,
  ProviderAuthRequiredCard,
  ReasoningItem,
  ToolCard,
  ToolStreak,
  UserBubble,
} from './thread-items'
import { ThreadCardCache } from './thread-open-cards'
import { SelectionToolbar, useCoarsePointer, useMessageSelection, type QuoteCapture } from '@/components/quote-selection'
import { threadRenderMode } from './thread-scroll'
import { DaySeparator, TurnTime, localDayKey } from './thread-time'
import {
  JumpToLatestPill,
  ThreadRows,
  useThreadScroll,
  type ThreadRow,
  type ThreadScrollControls,
} from './thread-scroller'
import { revealThreadRow } from './use-thread-my-messages'
import type {
  ThreadAsk,
  ThreadEntry,
  ThreadImage,
  ThreadNote,
  ThreadAgentUpdateRequired,
  ThreadProviderAuthRequired,
  ThreadState,
} from './thread-state'

export interface TranscriptUserMessage {
  text: string
  imageCount?: number
  images?: readonly string[]
  /** When this message was sent — or, for a still-queued one, when it was queued (#941). */
  ts?: string
}

export interface TranscriptSection {
  id: string
  userMessage?: TranscriptUserMessage
  /** Keeps the main renderer's established keys while allowing generic section ids. */
  userMessageKey?: string
  entries: readonly ThreadEntry[]
  /** The turn's own clock (#941): when it opened, and when the agent finished it. Absent on the
   *  initial-prompt, queued and attributed-agent sections, which have no turn boundaries. */
  startedAt?: string
  completedAt?: string
  /** Whether this section's stamp may move the thread's day cursor (#941). Default true; false
   *  for a section rendered OUT of chronological order, whose date says nothing about where the
   *  conversation below it sits in time. See `buildTranscriptRows`. */
  inDaySequence?: boolean
}

export interface TranscriptMessageActions {
  onEdit?: (text: string) => Promise<void>
  onRemove?: () => Promise<void>
  editLabel?: string
  removeLabel?: string
  /** The draft surface this row's inline editor writes to (#939) — `task-prompt` for the initial
   *  prompt, `message:<msgId>` for a queued message. Absent leaves the editor as it was: local
   *  state that dies with the row. */
  draftSurface?: string
}

export interface TranscriptRowModel {
  key: string
  scope: string
  content:
    | { kind: 'user-message'; message: TranscriptUserMessage }
    | { kind: 'block'; block: ThreadBlock }
    | { kind: 'day-separator'; ts: string }
    | { kind: 'turn-time'; completedAt: string; startedAt?: string }
    | { kind: 'artifacts'; artifacts: readonly RunArtifact[] }
}

export interface SessionTranscriptProps {
  runId: string
  viewId: string
  sections: readonly TranscriptSection[]
  mode: 'document' | 'panel'
  empty?: ReactNode
  /** Injects the run-aware reply behavior without coupling this view to run data or stores. */
  renderAsk?: (ask: ThreadAsk) => ReactNode
  messageActions?: Readonly<Record<string, TranscriptMessageActions>>
  /** Main-document integration preserves the shell's existing dock-owned jump pill. */
  scrollControls?: ThreadScrollControls
  renderMode?: 'flat' | 'virtual'
  /** Reuse rows already derived by the main view; panel callers can omit this. */
  rowModels?: readonly TranscriptRowModel[]
  onQuote?: (capture: QuoteCapture) => void
  /** The host's own `useMessageSelection()` (the task thread shares it with the composer's touch
   *  chip). Omitted: the transcript listens itself. `null` means no capture. */
  quoteCapture?: QuoteCapture | null
  /** The toolbar was closed (Esc, ✕) without quoting. */
  onQuoteDismiss?: () => void
  onJump?: (quote: MessageQuote) => void
  /** The section holding the agent's reply to the task (`turn-fallback-1`, no seq), given only
   *  once the history's oldest page is loaded. Its messages quote as ref 0. */
  firstTurnScope?: string
}

/** The `data-quote-owner` a transcript stamps on its quotable bodies. */
export const quoteOwnerOf = (runId: string, viewId: string) => `${runId}:${viewId}`

/** The main run record plus reduced turns, without rendering or backend inspection. */
export function mainTranscriptSections(run: ApiRun, thread: ThreadState): TranscriptSection[] {
  const sections: TranscriptSection[] = []
  // An attachment-only task (empty text) still opens the thread with its attachments.
  if (run.task || run.taskImages?.length) {
    sections.push({
      id: 'task',
      userMessageKey: 'task',
      // The initial prompt is not an event — the run record is where its clock lives (#941).
      userMessage: { text: run.task, images: run.taskImages ?? [], ts: run.createdAt },
      entries: [],
    })
  }
  for (const message of run.queuedMessages ?? []) {
    sections.push({
      id: `queued:${message.id}`,
      userMessageKey: `queued:${message.id}`,
      // Stamped with when it was QUEUED. Once it is sent, this section is gone and the turn's own
      // event `ts` takes over — the two differ, and that is the honest reading of both.
      userMessage: { text: message.text, images: message.images ?? [], ts: message.createdAt },
      // The stack renders here, above every turn, but is queued LAST: a message stacked onto a
      // run continued the next day is newer than the whole transcript beneath it. Its own stamp
      // stays on its bubble; it must not date the older turns below it (#941).
      inDaySequence: false,
      entries: [],
    })
  }
  for (const turn of thread.turns) {
    sections.push({
      id: turn.id,
      userMessageKey: `${turn.id}:user`,
      ...(turn.userMessage !== undefined
        ? {
            userMessage: {
              text: turn.userMessage.text,
              imageCount: turn.userMessage.imageCount,
              images: turn.userMessage.images,
              ...(turn.userMessage.ts !== undefined ? { ts: turn.userMessage.ts } : {}),
            },
          }
        : {}),
      ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
      ...(turn.completed?.ts !== undefined ? { completedAt: turn.completed.ts } : {}),
      entries: turn.items,
    })
  }
  return sections
}

/** One attributed agent stream becomes one ordinary transcript section. */
export function agentTranscriptSections(
  agentId: string,
  entries: readonly ThreadEntry[],
): TranscriptSection[] {
  return [{ id: `agent:${agentId}`, entries }]
}

/** When a section happened, for the day-separator comparison: the turn opens with the user's
 *  message when there is one, otherwise with the agent's own boundary stamps. Sections held out
 *  of the day sequence report nothing, so they neither draw a rule nor move the cursor. */
function sectionStamp(section: TranscriptSection): string | undefined {
  if (section.inDaySequence === false) return undefined
  return section.userMessage?.ts ?? section.startedAt ?? section.completedAt
}

/**
 * Pure flattening and grouping shared by document and panel surfaces.
 *
 * Day separators and the turn's closing time are ROWS of their own (#941), never content folded
 * into a neighbour: both render modes measure rows, and a stamp injected into an existing row
 * would change its height between virtua's measure and its paint.
 */
export function buildTranscriptRows(
  sections: readonly TranscriptSection[],
  _runId: string,
): TranscriptRowModel[] {
  const rows: TranscriptRowModel[] = []
  /** The latest local day the thread has shown, as a sortable `YYYY-MM-DD`. Sections with no
   *  stamp at all (attributed agent streams, old recordings) leave it alone rather than breaking
   *  the run of dates, as do sections held out of the sequence — the stack renders above the
   *  turns but is queued after them, and letting it set the cursor would both date the older
   *  turns wrongly and swallow the real boundary below. A separator is drawn only when the day
   *  moves FORWARD: the initial prompt is stamped from the run record while the turns below it
   *  are stamped from events, so a section that reads as older than what is already on screen is
   *  disorder, not a new day, and a "Yesterday" rule under today's turns would state something
   *  false. */
  let lastDay: string | undefined
  for (const section of sections) {
    const stamp = sectionStamp(section)
    const day = localDayKey(stamp)
    if (day !== undefined && stamp !== undefined && (lastDay === undefined || day > lastDay)) {
      // Only BETWEEN days: the first dated section needs no separator above it.
      if (lastDay !== undefined) {
        rows.push({
          key: `${section.id}:day-separator`,
          scope: section.id,
          content: { kind: 'day-separator', ts: stamp },
        })
      }
      lastDay = day
    }
    if (section.userMessage !== undefined) {
      rows.push({
        key: section.userMessageKey ?? `${section.id}:user`,
        scope: section.id,
        content: { kind: 'user-message', message: section.userMessage },
      })
    }
    for (const block of groupThreadItems([...section.entries])) {
      rows.push({
        key: `${section.id}:${block.id}`,
        scope: section.id,
        content: { kind: 'block', block },
      })
    }
    if (section.completedAt !== undefined) {
      rows.push({
        key: `${section.id}:turn-time`,
        scope: section.id,
        content: {
          kind: 'turn-time',
          completedAt: section.completedAt,
          ...(section.startedAt !== undefined ? { startedAt: section.startedAt } : {}),
        },
      })
    }
  }
  return rows
}

/**
 * Splices artifact cards into the rows at the turn that produced them (#2037). A file belongs to
 * the last in-sequence turn that had started by its `updatedAt`, so cards sit under that turn's
 * reply and scroll away with it. mtime moves when an agent rewrites a file: a rewritten asset
 * re-homes to the turn that last wrote it. With no turn stamps at all (old recordings) the cards
 * trail the transcript.
 */
export function placeArtifactRows(
  rows: readonly TranscriptRowModel[],
  sections: readonly TranscriptSection[],
  artifacts: readonly RunArtifact[],
): TranscriptRowModel[] {
  const cards = cardableArtifacts(artifacts)
  if (cards.length === 0) return [...rows]
  const starts = sections.flatMap((section) => {
    const start = section.inDaySequence === false ? undefined : section.userMessage?.ts ?? section.startedAt
    return start === undefined ? [] : [{ id: section.id, start }]
  })
  const byTurn = new Map<string | undefined, RunArtifact[]>()
  for (const artifact of byNewest(cards).reverse()) {
    const turn = [...starts].reverse().find(({ start }) => start <= artifact.updatedAt)?.id ?? starts[0]?.id
    byTurn.set(turn, [...(byTurn.get(turn) ?? []), artifact])
  }
  const out: TranscriptRowModel[] = []
  const lastRow = new Map<string, number>()
  rows.forEach((row, index) => lastRow.set(row.scope, index))
  const trailing = byTurn.get(undefined)
  rows.forEach((row, index) => {
    out.push(row)
    const group = lastRow.get(row.scope) === index ? byTurn.get(row.scope) : undefined
    if (group) out.push({ key: `${row.scope}:artifacts`, scope: row.scope, content: { kind: 'artifacts', artifacts: group } })
  })
  // A placement turn with no rows (cannot happen for stamped turns, but never drop a card).
  const placed = new Set(lastRow.keys())
  const orphaned = [...byTurn].filter(([id]) => id !== undefined && !placed.has(id)).flatMap(([, group]) => group)
  const rest = [...(trailing ?? []), ...orphaned]
  if (rest.length > 0) out.push({ key: 'artifacts:trailing', scope: 'artifacts', content: { kind: 'artifacts', artifacts: rest } })
  return out
}

export function SessionTranscript({
  runId,
  viewId,
  sections,
  mode,
  empty,
  renderAsk,
  messageActions,
  scrollControls,
  renderMode,
  rowModels: providedRowModels,
  onQuote,
  quoteCapture,
  onQuoteDismiss,
  onJump,
  firstTurnScope,
}: SessionTranscriptProps) {
  const rowModels = useMemo(
    () => providedRowModels ?? buildTranscriptRows(sections, runId),
    [providedRowModels, sections, runId],
  )
  const internalScroll = useThreadScroll(`${runId}:${viewId}`, { surface: mode })
  const controls = scrollControls ?? internalScroll
  // Only the main document's top-level messages are quotable; panels are a non-goal (spec § Non-goals).
  const quoteOwner = mode === 'document' && onQuote !== undefined ? quoteOwnerOf(runId, viewId) : undefined
  const ownSelection = useMessageSelection(quoteOwner !== undefined && quoteCapture === undefined)
  const capture = quoteCapture === undefined ? ownSelection : quoteCapture
  const ownCapture = quoteOwner !== undefined && capture?.source.dataset.quoteOwner === quoteOwner ? capture : null
  const coarse = useCoarsePointer()
  // Stable, so a streaming re-render does not re-bind the toolbar's listeners.
  const onQuoteDismissRef = useRef(onQuoteDismiss)
  onQuoteDismissRef.current = onQuoteDismiss
  const dismissQuote = useCallback(() => onQuoteDismissRef.current?.(), [])
  // A stable identity, so a caller's fresh arrow does not re-render every memoized row.
  const onJumpRef = useRef(onJump)
  onJumpRef.current = onJump
  const stableJump = useCallback((quote: MessageQuote) => onJumpRef.current?.(quote), [])
  const jump = onJump !== undefined ? stableJump : undefined
  const rows = useMemo<ThreadRow[]>(
    () =>
      rowModels.map((row) => ({
        key: row.key,
        node: (
          <MemoizedRow
            runId={runId}
            row={row}
            actions={messageActions?.[row.key]}
            renderAsk={renderAsk}
            quoteOwner={quoteOwner}
            onJump={jump}
          />
        ),
      })),
    [messageActions, jump, quoteOwner, renderAsk, rowModels, runId],
  )
  const rowMode = renderMode ?? threadRenderMode('', rows.length)

  const transcript =
    rows.length === 0 ? (
      empty ?? null
    ) : (
      <ThreadRows runId={`${runId}:${viewId}`} rows={rows} mode={rowMode} controls={controls} />
    )

  return (
    <ThreadCardCache runId={runId}>
      <FirstTurnScope.Provider value={firstTurnScope}>
      {mode === 'panel' ? (
        <div
          data-slot="transcript-viewport"
          aria-label="Agent transcript"
          role="region"
          tabIndex={0}
          className="relative flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div data-slot="subagent-stream" className="flex flex-col px-5 py-4">
            {transcript}
          </div>
          {controls.pillVisible ? (
            <div className="pointer-events-none sticky inset-x-0 bottom-4 flex justify-center">
              <JumpToLatestPill onJump={controls.jumpToLatest} />
            </div>
          ) : null}
        </div>
      ) : (
        transcript
      )}
      {ownCapture && onQuote ? (
        <SelectionToolbar capture={ownCapture} onQuote={onQuote} onDismiss={dismissQuote} placement={coarse ? 'below' : 'above'} />
      ) : null}
      </FirstTurnScope.Provider>
    </ThreadCardCache>
  )
}

/** Read by message rows only: changes once, when the oldest page arrives. */
const FirstTurnScope = createContext<string | undefined>(undefined)

/** The first turn's scope when it is the agent's reply to the task: it opens before any user
 *  message, so it has no seq (`turn-fallback-*`). Only meaningful with the oldest page loaded. */
export function firstTurnScopeOf(turnIds: readonly string[]): string | undefined {
  const first = turnIds[0]
  return first?.startsWith('turn-fallback-') ? first : undefined
}

type QuoteJump = (quote: MessageQuote) => void

function TranscriptRow({
  runId,
  row,
  actions,
  renderAsk,
  quoteOwner,
  onJump,
}: {
  runId: string
  row: TranscriptRowModel
  actions?: TranscriptMessageActions
  renderAsk?: (ask: ThreadAsk) => ReactNode
  quoteOwner?: string
  onJump?: QuoteJump
}) {
  return renderRowContent(runId, row, actions, renderAsk, quoteOwner, onJump)
}

const MemoizedRow = memo(
  TranscriptRow,
  (before, after) =>
    before.runId === after.runId &&
    before.actions === after.actions &&
    before.renderAsk === after.renderAsk &&
    before.quoteOwner === after.quoteOwner &&
    before.onJump === after.onJump &&
    sameData(before.row, after.row),
)

function renderRowContent(
  runId: string,
  row: TranscriptRowModel,
  actions: TranscriptMessageActions | undefined,
  renderAsk: ((ask: ThreadAsk) => ReactNode) | undefined,
  quoteOwner: string | undefined,
  onJump: QuoteJump | undefined,
): ReactNode {
  switch (row.content.kind) {
    case 'user-message':
      return <TranscriptUserBubble runId={runId} rowKey={row.key} message={row.content.message} actions={actions} quoteOwner={quoteOwner} onJump={onJump} />
    case 'day-separator':
      return <DaySeparator ts={row.content.ts} />
    case 'turn-time':
      return (
        <TurnTime
          completedAt={row.content.completedAt}
          {...(row.content.startedAt !== undefined ? { startedAt: row.content.startedAt } : {})}
        />
      )
    case 'artifacts':
      return <ThreadArtifactCards runId={runId} artifacts={row.content.artifacts} />
    case 'block':
      return <ThreadBlockRenderer block={row.content.block} scope={row.scope} renderAsk={renderAsk} quoteOwner={quoteOwner} onJump={onJump} />
    default:
      return assertNever(row.content)
  }
}

/** The `#n` of a turn scope (`turn-seq-<n>`); undefined for fallback and attributed sections. */
function turnRef(scope: string): number | undefined {
  const match = /^turn-seq-(\d+)$/.exec(scope)
  return match ? Number(match[1]) : undefined
}

/** The `#n` a user row's quote carries: 0 for the task description, the turn's seq otherwise. */
function userRowRef(key: string): number | undefined {
  if (key === 'task') return 0
  const match = /^turn-seq-(\d+):user$/.exec(key)
  return match ? Number(match[1]) : undefined
}

const plainText = (text: string) => text.replace(/[`*_~#>|[\]]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The row a quote's jump lands on (spec § 5): its exact row when loaded; for an assistant quote,
 * the turn's top-level message holding the excerpt's first line, else the turn's first one.
 */
export function quoteTargetRowKey(
  rows: readonly TranscriptRowModel[],
  quote: Pick<MessageQuote, 'role' | 'ref' | 'rowKey'> & { excerpt?: string },
): string | undefined {
  if (quote.rowKey !== undefined && rows.some((row) => row.key === quote.rowKey)) return quote.rowKey
  if (quote.ref === undefined) return undefined
  if (quote.ref === 0 && quote.role === 'assistant') {
    // The reply to the task: the first turn's rows, once the oldest page is loaded.
    const first = rows.find((row) => row.scope.startsWith('turn-'))?.scope
    return first?.startsWith('turn-fallback-') ? pickAssistantRow(rows.filter((row) => row.scope === first), quote.excerpt) : undefined
  }
  if (quote.ref === 0 || quote.role === 'user') {
    const key = quote.ref === 0 ? 'task' : `turn-seq-${quote.ref}:user`
    return rows.some((row) => row.key === key) ? key : undefined
  }
  const scope = `turn-seq-${quote.ref}`
  return pickAssistantRow(rows.filter((row) => row.scope === scope), quote.excerpt)
}

function pickAssistantRow(rows: readonly TranscriptRowModel[], excerpt: string | undefined): string | undefined {
  const candidates = rows.filter((row) => assistantText(row) !== undefined)
  const firstLine = plainText(excerpt?.split('\n').find((line) => line.trim() !== '') ?? '')
  const exact = firstLine === '' ? undefined : candidates.find((row) => plainText(assistantText(row)!).includes(firstLine))
  return (exact ?? candidates[0])?.key
}

function assistantText(row: TranscriptRowModel): string | undefined {
  if (row.content.kind !== 'block' || row.content.block.kind !== 'entry') return undefined
  const entry = row.content.block.entry
  return entry.kind === 'message' && entry.role === 'assistant' ? entry.text : undefined
}

/** True once the turn is loaded as far as the quote needs. A page that starts mid-turn carries the
 *  turn's user row as context, so only an older turn (or the task) proves its replies are all in. */
function turnStartLoaded(rows: readonly TranscriptRowModel[], ref: number, role: MessageQuote['role']): boolean {
  if (ref === 0) return rows.some((row) => row.key === 'task')
  return rows.some((row) =>
    (role === 'user' && row.key === `turn-seq-${ref}:user`) || row.key === 'task' || (turnRef(row.scope) ?? Infinity) < ref)
}

/**
 * A sent quote's Jump to message (spec § 5): pages back until the quoted turn is loaded, then
 * reveals the row with the landing ring (issue 2218). A source that is gone toasts and does not scroll.
 */
export function useQuoteJump({
  rows,
  history,
  scroll,
}: {
  rows: readonly TranscriptRowModel[]
  history: Pick<RunHistoryState, 'hasOlder' | 'loadOlder'> | undefined
  scroll: Pick<ThreadScrollControls, 'scrollElRef' | 'revealRow'>
}): QuoteJump {
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const historyRef = useRef(history)
  historyRef.current = history
  const scrollRef = useRef(scroll)
  scrollRef.current = scroll
  // A newer click supersedes a jump still paging, so repeated clicks never stack loops.
  const generation = useRef(0)
  return useCallback((quote: MessageQuote) => {
    const mine = ++generation.current
    void (async () => {
      const ref = quote.ref
      const settled = () => {
        const current = rowsRef.current
        if (quote.rowKey !== undefined && current.some((row) => row.key === quote.rowKey)) return true
        // The reply to the task is only identifiable with the oldest page loaded.
        if (ref === 0 && quote.role === 'assistant') return false
        return ref !== undefined && turnStartLoaded(current, ref, quote.role)
      }
      while (!settled() && historyRef.current?.hasOlder) {
        const before = rowsRef.current
        try {
          await historyRef.current.loadOlder()
        } catch {
          break
        }
        // The page resolves before its rows render; a page that adds nothing ends the walk.
        const grew = await untilFrame(() => rowsRef.current.length > before.length)
        if (mine !== generation.current) return
        if (!grew) break
      }
      if (mine !== generation.current) return
      const key = quoteTargetRowKey(rowsRef.current, quote)
      if (key === undefined) {
        toast('That message is no longer in this transcript.', { tone: 'danger' })
        return
      }
      const row = await revealThreadRow(scrollRef.current, key)
      const target = row?.querySelector<HTMLElement>('[data-slot="user-bubble"], [data-slot="assistant-message"]') ?? row
      if (target) highlightJumpTarget(target)
    })()
  }, [])
}

function TranscriptUserBubble({
  runId,
  rowKey,
  message,
  actions,
  quoteOwner,
  onJump,
}: {
  runId: string
  rowKey: string
  message: TranscriptUserMessage
  actions?: TranscriptMessageActions
  quoteOwner?: string
  onJump?: QuoteJump
}) {
  const ref = userRowRef(rowKey)
  return (
    <UserBubble
      text={message.text}
      imageCount={message.imageCount}
      images={message.images}
      {...(message.ts !== undefined ? { ts: message.ts } : {})}
      onEdit={actions?.onEdit}
      onRemove={actions?.onRemove}
      editLabel={actions?.editLabel}
      removeLabel={actions?.removeLabel}
      draftRunId={actions?.draftSurface !== undefined ? runId : undefined}
      draftSurface={actions?.draftSurface}
      {...(quoteOwner !== undefined ? { quoteSource: { owner: quoteOwner, ...(ref !== undefined ? { ref } : {}) } } : {})}
      onJump={onJump}
    />
  )
}

const ThreadBlockRenderer = memo(function ThreadBlockRenderer({
  block,
  scope,
  renderAsk,
  quoteOwner,
  onJump,
}: {
  block: ThreadBlock
  scope: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
  /** Set only for a top-level row: messages nested in tool cards are not quotable. */
  quoteOwner?: string
  onJump?: QuoteJump
}): ReactNode {
  switch (block.kind) {
    case 'entry':
      return <ThreadEntryRenderer entry={block.entry} scope={scope} renderAsk={renderAsk} quoteOwner={quoteOwner} onJump={onJump} />
    case 'tool-card':
      return (
        <ToolCard
          item={block.item}
          nested={block.children}
          cacheKey={`${scope}:${block.id}`}
          renderNested={(entries, nestedScope) => (
            <GroupedEntries entries={entries} scope={nestedScope} renderAsk={renderAsk} />
          )}
        />
      )
    case 'context-group':
      return <ContextGroup group={block} scope={scope} />
    case 'streak':
      return (
        <ToolStreak count={block.count}>
          {block.blocks.map((inner) => (
            <ThreadBlockRenderer key={inner.id} block={inner} scope={scope} renderAsk={renderAsk} />
          ))}
        </ToolStreak>
      )
    default:
      return assertNever(block)
  }
}, sameThreadBlockProps)

function GroupedEntries({
  entries,
  scope,
  renderAsk,
}: {
  entries: readonly ThreadEntry[]
  scope: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
}) {
  return groupThreadItems([...entries]).map((block) => (
    <ThreadBlockRenderer key={block.id} block={block} scope={scope} renderAsk={renderAsk} />
  ))
}

function ThreadEntryRenderer({
  entry,
  scope,
  renderAsk,
  quoteOwner,
  onJump,
}: {
  entry: ThreadEntry
  scope: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
  quoteOwner?: string
  onJump?: QuoteJump
}): ReactNode {
  const firstTurnScope = useContext(FirstTurnScope)
  switch (entry.kind) {
    case 'message': {
      const ref = turnRef(scope) ?? (firstTurnScope === scope ? 0 : undefined)
      const quoteSource = quoteOwner !== undefined ? { owner: quoteOwner, ...(ref !== undefined ? { ref } : {}) } : undefined
      return entry.role === 'assistant' ? (
        <AssistantMessage text={entry.text} quoteSource={quoteSource} />
      ) : (
        <UserBubble text={entry.text} quoteSource={quoteSource} onJump={onJump} />
      )
    }
    case 'reasoning':
      return <ReasoningItem text={entry.text} />
    case 'tool':
      return <ToolCard item={entry} cacheKey={`${scope}:${entry.id}`} />
    case 'note':
      return <NoteLine note={entry} />
    case 'image':
      return <ImageItem image={entry} />
    case 'ask':
      return renderAsk !== undefined ? (
        renderAsk(entry)
      ) : (
        <div data-slot="ask-card" className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
          The agent asked a question. Open the main session to answer it.
        </div>
      )
    case 'provider-auth-required':
      return <ProviderAuthRequiredCard incident={entry} />
    case 'agent-update-required':
      return <AgentUpdateRequiredCard incident={entry} />
    default:
      return assertNever(entry)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript variant: ${JSON.stringify(value)}`)
}

type ThreadBlockProps = { block: ThreadBlock; scope: string; renderAsk?: (ask: ThreadAsk) => ReactNode; quoteOwner?: string; onJump?: QuoteJump }

function sameThreadBlockProps(previous: ThreadBlockProps, next: ThreadBlockProps): boolean {
  return (
    previous.scope === next.scope &&
    previous.quoteOwner === next.quoteOwner &&
    previous.onJump === next.onJump &&
    sameThreadBlock(previous.block, next.block) &&
    (!containsAsk(next.block) || previous.renderAsk === next.renderAsk)
  )
}

function containsAsk(block: ThreadBlock): boolean {
  if (block.kind === 'entry') return block.entry.kind === 'ask'
  if (block.kind === 'tool-card') return block.children.some((entry) => entry.kind === 'ask')
  if (block.kind === 'context-group') return false
  return block.blocks.some(containsAsk)
}

function sameThreadBlock(previous: ThreadBlock, next: ThreadBlock): boolean {
  if (previous.kind !== next.kind || previous.id !== next.id) return false
  switch (next.kind) {
    case 'entry':
      return sameThreadEntry(previous.kind === 'entry' ? previous.entry : undefined, next.entry)
    case 'tool-card':
      return (
        previous.kind === 'tool-card' &&
        sameToolItem(previous.item, next.item) &&
        sameThreadEntries(previous.children, next.children)
      )
    case 'context-group':
      return (
        previous.kind === 'context-group' &&
        previous.files === next.files &&
        previous.searches === next.searches &&
        previous.label === next.label &&
        previous.tools.length === next.tools.length &&
        previous.tools.every((item, index) => sameToolItem(item, next.tools[index]!))
      )
    case 'streak':
      return (
        previous.kind === 'streak' &&
        previous.count === next.count &&
        previous.blocks.length === next.blocks.length &&
        previous.blocks.every((block, index) => sameThreadBlock(block, next.blocks[index]!))
      )
    default:
      return false
  }
}

function sameThreadEntries(previous: readonly ThreadEntry[], next: readonly ThreadEntry[]): boolean {
  return previous.length === next.length && previous.every((entry, index) => sameThreadEntry(entry, next[index]!))
}

function sameThreadEntry(previous: ThreadEntry | undefined, next: ThreadEntry): boolean {
  if (previous === undefined || previous.kind !== next.kind || previous.id !== next.id) return false
  switch (next.kind) {
    case 'message':
      return previous.kind === 'message' && sameFields(previous, next, MESSAGE_COMPARE_FIELDS)
    case 'reasoning':
      return previous.kind === 'reasoning' && sameFields(previous, next, REASONING_COMPARE_FIELDS)
    case 'tool':
      return previous.kind === 'tool' && sameToolItem(previous, next)
    case 'note':
      return previous.kind === 'note' && sameFields<Omit<ThreadNote, 'skillNames'>>(previous, next, NOTE_COMPARE_FIELDS) &&
        sameData(previous.skillNames, next.skillNames)
    case 'image':
      return previous.kind === 'image' && sameFields(previous, next, IMAGE_COMPARE_FIELDS)
    case 'ask':
      return previous.kind === 'ask' && sameFields<Omit<ThreadAsk, 'closed'>>(previous, next, ASK_COMPARE_FIELDS) &&
        (previous.closed === next.closed || (previous.closed !== undefined && next.closed !== undefined && sameFields(previous.closed, next.closed, ASK_CLOSED_COMPARE_FIELDS)))
    case 'provider-auth-required':
      return previous.kind === 'provider-auth-required' &&
        sameFields(previous, next, PROVIDER_AUTH_COMPARE_FIELDS)
    case 'agent-update-required':
      return previous.kind === 'agent-update-required' &&
        sameFields(previous, next, AGENT_UPDATE_COMPARE_FIELDS)
    default:
      return false
  }
}

const MESSAGE_COMPARE_FIELDS = {
  kind: true,
  id: true,
  role: true,
  text: true,
  phase: true,
  parentItemId: true,
} satisfies Record<keyof UiMessageItem, true>

const REASONING_COMPARE_FIELDS = {
  kind: true,
  id: true,
  text: true,
  parentItemId: true,
} satisfies Record<keyof UiReasoningItem, true>

const NOTE_COMPARE_FIELDS = {
  kind: true,
  id: true,
  text: true,
  tone: true,
  action: true,
} satisfies Record<keyof Omit<ThreadNote, 'skillNames'>, true>

const IMAGE_COMPARE_FIELDS = {
  kind: true,
  id: true,
  url: true,
  name: true,
} satisfies Record<keyof ThreadImage, true>

const ASK_COMPARE_FIELDS = {
  kind: true,
  id: true,
  questions: true,
  resolved: true,
  answer: true,
  fromWorkflow: true,
} satisfies Record<Exclude<keyof ThreadAsk, 'closed'>, true>

// `closed` is a fresh object per reduce, so it is compared by its fields.

const ASK_CLOSED_COMPARE_FIELDS = {
  reason: true,
  detail: true,
  replacedBy: true,
  answer: true,
  answeredIn: true,
  at: true,
} satisfies Record<keyof NonNullable<ThreadAsk['closed']>, true>

const PROVIDER_AUTH_COMPARE_FIELDS = {
  kind: true,
  id: true,
  provider: true,
  authFailureId: true,
  profileId: true,
  state: true,
  reconnectedAt: true,
} satisfies Record<keyof ThreadProviderAuthRequired, true>

const AGENT_UPDATE_COMPARE_FIELDS = {
  kind: true,
  id: true,
  provider: true,
} satisfies Record<keyof ThreadAgentUpdateRequired, true>

/** A new transcript item field must be added here before it can be ignored by memoization. */
const TOOL_ITEM_COMPARE_FIELDS = {
  kind: true,
  id: true,
  name: true,
  toolKind: true,
  title: true,
  status: true,
  input: true,
  output: true,
  error: true,
  diffs: true,
  locations: true,
  exitCode: true,
  parentItemId: true,
} satisfies Record<keyof UiToolItem, true>

function sameFields<T extends object>(
  previous: T,
  next: T,
  fields: Record<keyof T, true>,
): boolean {
  return (Object.keys(fields) as Array<keyof T>).every((key) => previous[key] === next[key])
}

function sameToolItem(previous: UiToolItem, next: UiToolItem): boolean {
  return sameFields(previous, next, TOOL_ITEM_COMPARE_FIELDS)
}

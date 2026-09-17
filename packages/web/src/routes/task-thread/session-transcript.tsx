import { memo, useMemo, type ReactNode } from 'react'

import type { ApiRun, UiMessageItem, UiReasoningItem, UiToolItem } from '@open-mercato/cezar-api-client'
import { sameData } from '@/lib/same-data'

import { groupThreadItems, type ThreadBlock } from './thread-groups'
import {
  AssistantMessage,
  ContextGroup,
  ImageItem,
  NoteLine,
  ProviderAuthRequiredCard,
  ReasoningItem,
  ToolCard,
  ToolStreak,
  UserBubble,
} from './thread-items'
import { ThreadCardCache } from './thread-open-cards'
import { threadRenderMode } from './thread-scroll'
import { DaySeparator, TurnTime, localDayKey } from './thread-time'
import {
  JumpToLatestPill,
  ThreadRows,
  useThreadScroll,
  type ThreadRow,
  type ThreadScrollControls,
} from './thread-scroller'
import type {
  ThreadAsk,
  ThreadEntry,
  ThreadImage,
  ThreadNote,
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
}

/** The main run record plus reduced turns, without rendering or backend inspection. */
export function mainTranscriptSections(run: ApiRun, thread: ThreadState): TranscriptSection[] {
  const sections: TranscriptSection[] = []
  if (run.task) {
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
}: SessionTranscriptProps) {
  const rowModels = useMemo(
    () => providedRowModels ?? buildTranscriptRows(sections, runId),
    [providedRowModels, sections, runId],
  )
  const internalScroll = useThreadScroll(`${runId}:${viewId}`, { surface: mode })
  const controls = scrollControls ?? internalScroll
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
          />
        ),
      })),
    [messageActions, renderAsk, rowModels, runId],
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
    </ThreadCardCache>
  )
}

function TranscriptRow({
  runId,
  row,
  actions,
  renderAsk,
}: {
  runId: string
  row: TranscriptRowModel
  actions?: TranscriptMessageActions
  renderAsk?: (ask: ThreadAsk) => ReactNode
}) {
  return renderRowContent(runId, row, actions, renderAsk)
}

const MemoizedRow = memo(
  TranscriptRow,
  (before, after) =>
    before.runId === after.runId &&
    before.actions === after.actions &&
    before.renderAsk === after.renderAsk &&
    sameData(before.row, after.row),
)

function renderRowContent(
  runId: string,
  row: TranscriptRowModel,
  actions: TranscriptMessageActions | undefined,
  renderAsk: ((ask: ThreadAsk) => ReactNode) | undefined,
): ReactNode {
  switch (row.content.kind) {
    case 'user-message':
      return <TranscriptUserBubble runId={runId} message={row.content.message} actions={actions} />
    case 'day-separator':
      return <DaySeparator ts={row.content.ts} />
    case 'turn-time':
      return (
        <TurnTime
          completedAt={row.content.completedAt}
          {...(row.content.startedAt !== undefined ? { startedAt: row.content.startedAt } : {})}
        />
      )
    case 'block':
      return <ThreadBlockRenderer block={row.content.block} scope={row.scope} renderAsk={renderAsk} />
    default:
      return assertNever(row.content)
  }
}

function TranscriptUserBubble({
  runId,
  message,
  actions,
}: {
  runId: string
  message: TranscriptUserMessage
  actions?: TranscriptMessageActions
}) {
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
    />
  )
}

const ThreadBlockRenderer = memo(function ThreadBlockRenderer({
  block,
  scope,
  renderAsk,
}: {
  block: ThreadBlock
  scope: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
}): ReactNode {
  switch (block.kind) {
    case 'entry':
      return <ThreadEntryRenderer entry={block.entry} scope={scope} renderAsk={renderAsk} />
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
}: {
  entry: ThreadEntry
  scope: string
  renderAsk?: (ask: ThreadAsk) => ReactNode
}): ReactNode {
  switch (entry.kind) {
    case 'message':
      return entry.role === 'assistant' ? (
        <AssistantMessage text={entry.text} />
      ) : (
        <UserBubble text={entry.text} />
      )
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
    default:
      return assertNever(entry)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript variant: ${JSON.stringify(value)}`)
}

function sameThreadBlockProps(
  previous: { block: ThreadBlock; scope: string; renderAsk?: (ask: ThreadAsk) => ReactNode },
  next: { block: ThreadBlock; scope: string; renderAsk?: (ask: ThreadAsk) => ReactNode },
): boolean {
  return (
    previous.scope === next.scope &&
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
      return previous.kind === 'note' && sameFields(previous, next, NOTE_COMPARE_FIELDS)
    case 'image':
      return previous.kind === 'image' && sameFields(previous, next, IMAGE_COMPARE_FIELDS)
    case 'ask':
      return previous.kind === 'ask' && sameFields(previous, next, ASK_COMPARE_FIELDS)
    case 'provider-auth-required':
      return previous.kind === 'provider-auth-required' &&
        sameFields(previous, next, PROVIDER_AUTH_COMPARE_FIELDS)
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
} satisfies Record<keyof ThreadNote, true>

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
} satisfies Record<keyof ThreadAsk, true>

const PROVIDER_AUTH_COMPARE_FIELDS = {
  kind: true,
  id: true,
  provider: true,
  authFailureId: true,
} satisfies Record<keyof ThreadProviderAuthRequired, true>

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

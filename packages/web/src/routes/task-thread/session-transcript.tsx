import { useMemo, type ReactNode } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'

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
import type { ThreadAsk, ThreadEntry, ThreadState } from './thread-state'

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
}

export interface TranscriptMessageActions {
  onEdit?: (text: string) => Promise<void>
  onRemove?: () => Promise<void>
  editLabel?: string
  removeLabel?: string
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
 *  message when there is one, otherwise with the agent's own boundary stamps. */
function sectionStamp(section: TranscriptSection): string | undefined {
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
   *  the run of dates. A separator is drawn only when the day moves FORWARD: the initial prompt
   *  is stamped from the run record while the turns below it are stamped from events, so a
   *  section that reads as older than what is already on screen is disorder, not a new day, and
   *  a "Yesterday" rule under today's turns would state something false. */
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
}: SessionTranscriptProps) {
  const rowModels = useMemo(() => buildTranscriptRows(sections, runId), [sections, runId])
  const internalScroll = useThreadScroll(`${runId}:${viewId}`, { surface: mode })
  const controls = scrollControls ?? internalScroll
  const rows = useMemo<ThreadRow[]>(
    () =>
      rowModels.map((row) => ({
        key: row.key,
        node: renderRowContent(row, messageActions?.[row.key], renderAsk),
      })),
    [messageActions, renderAsk, rowModels],
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

function renderRowContent(
  row: TranscriptRowModel,
  actions: TranscriptMessageActions | undefined,
  renderAsk: ((ask: ThreadAsk) => ReactNode) | undefined,
): ReactNode {
  switch (row.content.kind) {
    case 'user-message':
      return <TranscriptUserBubble message={row.content.message} actions={actions} />
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
  message,
  actions,
}: {
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
    />
  )
}

function ThreadBlockRenderer({
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
}

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

import { memo, useMemo, type ReactNode } from 'react'

import type { ApiRun, UiMessageItem, UiReasoningItem, UiToolItem } from '@open-mercato/cezar-api-client'

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
}

export interface TranscriptSection {
  id: string
  userMessage?: TranscriptUserMessage
  /** Keeps the main renderer's established keys while allowing generic section ids. */
  userMessageKey?: string
  entries: readonly ThreadEntry[]
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
      userMessage: { text: run.task, images: run.taskImages ?? [] },
      entries: [],
    })
  }
  for (const message of run.queuedMessages ?? []) {
    sections.push({
      id: `queued:${message.id}`,
      userMessageKey: `queued:${message.id}`,
      userMessage: { text: message.text, images: message.images ?? [] },
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
            },
          }
        : {}),
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

/** Pure flattening and grouping shared by document and panel surfaces. */
export function buildTranscriptRows(
  sections: readonly TranscriptSection[],
  _runId: string,
): TranscriptRowModel[] {
  const rows: TranscriptRowModel[] = []
  for (const section of sections) {
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
        node:
          row.content.kind === 'user-message' ? (
            <TranscriptUserBubble
              message={row.content.message}
              actions={messageActions?.[row.key]}
            />
          ) : (
            <ThreadBlockRenderer block={row.content.block} scope={row.scope} renderAsk={renderAsk} />
          ),
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
      onEdit={actions?.onEdit}
      onRemove={actions?.onRemove}
      editLabel={actions?.editLabel}
      removeLabel={actions?.removeLabel}
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

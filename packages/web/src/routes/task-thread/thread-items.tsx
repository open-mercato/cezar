import {
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderInputIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  SearchIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ZoomableImage } from '@/components/zoomable-image'
import { Link } from '@/lib/project-router'
import type { FileDiff, ToolKind, UiToolItem } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

import { Markdown } from './markdown'
import { splitToolTitle, streakLabel, type ContextGroupBlock } from './thread-groups'
import { useThreadCardCache } from './thread-open-cards'
import { isNearBottom } from './thread-scroll'
import type { ThreadEntry, ThreadImage, ThreadNote, ThreadProviderAuthRequired } from './thread-state'

// The stick rule lives with the rest of the scroll math now; re-exported because this is
// where the live tail below consumes it.
export { isNearBottom }

/**
 * The thread's per-entry building blocks (mockup: docs/mockups/thread.html). Presentational
 * only — everything they show comes from the reducer's output and `groupThreadItems`; nothing
 * is derived here except open/closed UI state.
 */

/** Right-aligned muted bubble — a v1 `user-message` line or the run's initial task. Renders any
 *  attached images inline; falls back to a count only when the URLs aren't available (older runs).
 *
 *  The text renders as MARKDOWN, like `AssistantMessage` (#524): what a user sends is markdown as
 *  often as what the agent replies — the GitHub hand-off prompt alone carries a `#N` heading-ish
 *  line, a bare link and a `---` rule — and rendering one side raw made the same document look
 *  broken on the way in and fine on the way out. `whitespace-pre-wrap` goes with it: Streamdown
 *  owns the line breaks now, and leaving it on would double every blank line.
 *
 *  `onEdit` / `onRemove` (#472) are the queued-run affordances: passing one renders its control.
 *  They are passed ONLY while the run is still queued, so once it starts the bubbles go read-only
 *  on the next `run` frame — the stack has become history. The initial prompt gets `onEdit` but
 *  never `onRemove`: a run with no prompt is not a run. The inline editor deliberately edits the
 *  RAW markdown source (`text`), not the rendered output. */
export function UserBubble({
  text,
  imageCount = 0,
  images = [],
  onEdit,
  onRemove,
  editLabel = 'Edit message',
  removeLabel = 'Remove message',
}: {
  text: string
  imageCount?: number
  images?: readonly string[]
  onEdit?: (text: string) => Promise<void>
  onRemove?: () => Promise<void>
  editLabel?: string
  removeLabel?: string
}) {
  const missing = imageCount - images.length
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const startEditing = () => {
    setDraft(text)
    setActionError(undefined)
    setEditing(true)
  }
  const save = async () => {
    const next = draft.trim()
    // An empty edit is a no-op rather than a delete: removing is its own, explicit action.
    if (!next || next === text) {
      setEditing(false)
      return
    }
    setBusy(true)
    setActionError(undefined)
    try {
      await onEdit?.(next)
      setEditing(false)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the message')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setActionError(undefined)
    try {
      await onRemove?.()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not remove the message')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div
        data-slot="user-bubble"
        data-editing="true"
        className="max-w-[78%] self-end rounded-2xl rounded-br-md bg-muted px-[15px] py-2.5 text-[13.5px] leading-[1.55] md:max-w-[70%]"
      >
        <textarea
          autoFocus
          aria-label="Edit the message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Escape cancels; ⌘/Ctrl+Enter saves. Plain Enter stays a newline — these are
            // prompt paragraphs, not chat sends.
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            }
          }}
          className="block max-h-[220px] min-h-[60px] w-full resize-none rounded-md bg-background px-2 py-1.5 text-[13.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <span className="mt-1.5 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            className="rounded-sm px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-sm bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:brightness-[0.96] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : 'Save'}
          </button>
        </span>
        {actionError ? <p role="alert" className="mt-1.5 text-xs text-danger">{actionError}</p> : null}
      </div>
    )
  }

  return (
    <div
      data-slot="user-bubble"
      className="group max-w-[78%] min-w-0 self-end rounded-2xl rounded-br-md bg-muted px-[15px] py-2.5 text-[13.5px] leading-[1.55] md:max-w-[70%]"
    >
      {onEdit || onRemove ? (
        <span
          data-slot="bubble-actions"
          className="mb-1 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        >
          {onEdit ? (
            <button
              type="button"
              aria-label={editLabel}
              onClick={startEditing}
              disabled={busy}
              className="rounded-sm p-1 text-soft-foreground hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <SquarePenIcon className="size-3.5" />
            </button>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              aria-label={removeLabel}
              onClick={() => void remove()}
              disabled={busy}
              className="rounded-sm p-1 text-soft-foreground hover:bg-background hover:text-danger focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          ) : null}
        </span>
      ) : null}
      {actionError ? <p role="alert" className="mb-1 text-xs text-danger">{actionError}</p> : null}
      <Markdown breaks>{text}</Markdown>
      {images.length > 0 ? (
        <span data-slot="user-images" className="mt-2 flex flex-wrap justify-end gap-1.5">
          {images.map((url) => (
            <ZoomableImage
              key={url}
              src={url}
              alt="attached"
              className="max-h-40 max-w-[220px] rounded-md border border-border object-contain"
            />
          ))}
        </span>
      ) : null}
      {missing > 0 ? (
        <span className="mt-1 block text-xs text-soft-foreground">
          {missing} image{missing > 1 ? 's' : ''} attached
        </span>
      ) : null}
    </div>
  )
}

/** An assistant message item, as markdown. */
export function AssistantMessage({ text }: { text: string }) {
  return (
    <div data-slot="assistant-message" className="min-w-0 text-[15px] leading-[1.65]">
      <Markdown>{text}</Markdown>
    </div>
  )
}

/** A dim (lifecycle/note) or danger (error) transcript line. */
export function NoteLine({ note }: { note: ThreadNote }) {
  return (
    <div
      data-slot="note-line"
      data-tone={note.tone}
      className={cn('px-0.5 text-xs', note.tone === 'danger' ? 'text-danger' : 'text-soft-foreground')}
    >
      {note.tone === 'danger' ? '✗ ' : '· '}
      {note.text}
    </div>
  )
}

const PROVIDER_LABEL: Record<ThreadProviderAuthRequired['provider'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/** Persisted recovery guidance for an authoritative runtime authentication rejection. */
export function ProviderAuthRequiredCard({
  incident,
}: {
  incident: ThreadProviderAuthRequired
}) {
  const label = PROVIDER_LABEL[incident.provider]
  return (
    <div
      role="alert"
      data-slot="provider-auth-required"
      className="rounded-md border border-danger/30 bg-danger/5 px-3.5 py-3"
    >
      <p className="text-[13px] font-semibold text-foreground">
        This run needed {label} authorization
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Review {label} settings before retrying.
      </p>
      <Link
        to="/settings/agents#providers"
        className="mt-2 inline-flex text-xs font-medium text-foreground underline-offset-2 hover:underline"
      >
        Open provider settings
      </Link>
    </div>
  )
}

/**
 * Reasoning: a collapsed dim "Thinking — {first line}…" row, expandable to the full text.
 * Streams live — the reducer grows `text` in place, so the summary line grows with it.
 */
export function ReasoningItem({ text }: { text: string }) {
  const previewId = useId()
  // A mapper regression that mints an empty reasoning item should degrade
  // quietly rather than render a bare, un-expandable "Thinking —" row (#528).
  if (text.trim() === '') return null
  const firstLine = text.split('\n', 1)[0] ?? ''
  const truncated = firstLine.length < text.length
  return (
    <Collapsible data-slot="reasoning" className="group/reasoning min-w-0">
      <div
        id={previewId}
        className="relative flex w-full items-center gap-1.5 rounded-md p-0.5 text-left text-[13px] text-soft-foreground hover:text-muted-foreground"
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]/reasoning:rotate-90"
        />
        <span className="shrink-0">Thinking — </span>
        <div className="min-w-0 truncate text-muted-foreground">
          <Markdown inline>{firstLine}</Markdown>
        </div>
        {truncated ? <span aria-hidden>…</span> : null}
        {/* Keep rendered Markdown OUTSIDE the trigger: links are unwrapped above, and the native
            button overlays the preview without inheriting invalid block descendants. */}
        <CollapsibleTrigger
          aria-labelledby={previewId}
          className="absolute inset-0 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        />
      </div>
      <CollapsibleContent>
        <div className="px-6 py-1.5 text-[13px] leading-[1.6] text-soft-foreground">
          <Markdown>{text}</Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Live "the agent is working" affordance for an active session. A running run
 * streams in bursts with quiet gaps between turns (thinking, tool setup), and
 * with nothing on screen the user cannot tell whether more output is coming.
 * This spinner + shimmering label sits at the tail of the thread for exactly
 * the `running` window, so the session never looks stalled when it is not.
 */
export function WorkingIndicator() {
  return (
    <div
      data-slot="working-indicator"
      className="flex items-center gap-2 py-1 text-[13px] text-soft-foreground"
    >
      <LoaderCircleIcon role="status" aria-label="Working" className="size-3.5 shrink-0 animate-spin" />
      <span className="shimmer font-medium">Working…</span>
    </div>
  )
}

const TOOL_ICONS: Record<ToolKind, typeof WrenchIcon> = {
  read: FileTextIcon,
  edit: SquarePenIcon,
  delete: Trash2Icon,
  move: FolderInputIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  task: BotIcon,
  plan: ListTodoIcon,
  other: WrenchIcon,
}

/** Beyond this many lines a finished output clamps behind the fade + "Show all" control. */
export const OUTPUT_CLAMP_LINES = 12

const countLines = (text: string): number => text.split('\n').length

/**
 * Mono tool output (mockup `.tool-body`). While streaming it is a live tail: bounded height,
 * auto-scrolled as deltas append until the user scrolls up. Once finished, long output clamps
 * behind a bottom fade with an explicit "Show all N lines" expansion.
 */
function ToolOutput({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const box = boxRef.current
    if (streaming && box && stickRef.current) box.scrollTop = box.scrollHeight
  }, [text, streaming])

  const lines = countLines(text)
  const clamped = !streaming && !expanded && lines > OUTPUT_CLAMP_LINES
  return (
    <div data-slot="tool-output" data-clamped={clamped ? 'true' : undefined}>
      <div className="relative">
        <div
          ref={boxRef}
          onScroll={
            streaming
              ? (event) => {
                  stickRef.current = isNearBottom(event.currentTarget)
                }
              : undefined
          }
          className={cn(
            'overflow-x-auto',
            streaming && 'max-h-[216px] overflow-y-auto',
            clamped && 'max-h-[216px] overflow-y-hidden',
          )}
        >
          <pre className="px-4 py-3 font-mono text-xs leading-[1.7] whitespace-pre text-muted-foreground">{text}</pre>
        </div>
        {clamped ? (
          <div
            data-slot="tool-output-fade"
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-card-2"
          />
        ) : null}
      </div>
      {!streaming && lines > OUTPUT_CLAMP_LINES ? (
        <button
          type="button"
          data-slot="tool-output-toggle"
          onClick={() => setExpanded((value) => !value)}
          className="block w-full border-t border-border/50 px-4 py-1.5 text-left text-[11px] font-medium text-soft-foreground hover:text-foreground"
        >
          {expanded ? 'Show less' : `Show all ${lines} lines`}
        </button>
      ) : null}
    </div>
  )
}

/**
 * NAMED BOUNDARY for R5: the real word-level `<Diff>` replaces this component's body without
 * touching the tool card. Until then, edits render as a plain unified block from the item's
 * `diffs` — old lines tinted del, new lines tinted add, `unified` text preferred when present.
 */
export function InlineDiffPreview({ diffs }: { diffs: FileDiff[] }) {
  return (
    <>
      {diffs.map((diff, index) => (
        <div key={`${diff.path}:${index}`} data-slot="diff-preview" className="min-w-0">
          <div className="border-b border-border/50 px-4 py-1.5 font-mono text-[11px] text-soft-foreground">
            {diff.path}
          </div>
          <pre className="overflow-x-auto py-2 font-mono text-xs leading-[1.7] whitespace-pre">
            {diff.unified !== undefined
              ? diff.unified.split('\n').map((line, i) => <DiffLine key={i} text={line} />)
              : [
                  ...diffLines(diff.oldText).map((line, i) => (
                    <span key={`old-${i}`} className="block bg-diff-del px-4 text-muted-foreground">
                      - {line}
                    </span>
                  )),
                  ...diffLines(diff.newText).map((line, i) => (
                    <span key={`new-${i}`} className="block bg-diff-add px-4">
                      + {line}
                    </span>
                  )),
                ]}
          </pre>
        </div>
      ))}
    </>
  )
}

/** Old/new file text → displayable lines; `null`/absent sides (new files) contribute none. */
function diffLines(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text === '') return []
  return text.replace(/\n$/, '').split('\n')
}

function DiffLine({ text }: { text: string }) {
  return (
    <span
      className={cn(
        'block px-4',
        text.startsWith('+') && 'bg-diff-add',
        text.startsWith('-') && 'bg-diff-del text-muted-foreground',
        text.startsWith('@@') && 'text-soft-foreground',
      )}
    >
      {text}
    </span>
  )
}

/** Default-open policy: a running command opens to show its live tail; everything else —
 *  including edits, finished commands AND failures — starts closed but prominent. A failed step
 *  no longer springs its red error body open on its own (it reads as calmer that way, and a
 *  recovered failure is not an emergency); its collapsed row still carries the `failed` label and
 *  exit code. The user's own toggle always wins once they touch the card. */
function defaultOpen(item: UiToolItem): boolean {
  return item.toolKind === 'execute' && item.status === 'running' && item.output !== undefined
}

/**
 * One tool invocation as a shadcn Collapsible card (mockup `.tool-card`, issue #381).
 * Locked (no chevron, trigger disabled) until the item has any detail to show. `nested` is the
 * sub-agent's items (`parentItemId` → this card), rendered indented in the body, one level.
 *
 * `cacheKey` (thread only — turn-scoped, since item ids repeat across sessions) remembers the
 * user's explicit open/close in the per-run open-card cache, so revisiting a thread restores
 * the cards as left. Without a key or outside a ThreadCardCache, the state is plain local.
 */
export function ToolCard({
  item,
  nested = [],
  cacheKey,
  renderNested,
}: {
  item: UiToolItem
  nested?: readonly ThreadEntry[]
  cacheKey?: string
  renderNested?: (entries: readonly ThreadEntry[], scope: string) => ReactNode
}) {
  const cache = useThreadCardCache()
  const [userOpen, setUserOpenState] = useState<boolean | null>(
    () => (cacheKey !== undefined ? (cache?.get(cacheKey) ?? null) : null),
  )
  const setUserOpen = (open: boolean) => {
    if (cacheKey !== undefined) cache?.set(cacheKey, open)
    setUserOpenState(open)
  }
  const busy = item.status === 'running' || item.status === 'pending'
  const hasDetail =
    (item.output !== undefined && item.output !== '') ||
    (item.error !== undefined && item.error !== '') ||
    (item.diffs !== undefined && item.diffs.length > 0) ||
    nested.length > 0
  const open = hasDetail && (userOpen ?? defaultOpen(item))
  const { verb, detail } = splitToolTitle(item.title)

  const Icon = TOOL_ICONS[item.toolKind] ?? WrenchIcon
  return (
    <Collapsible
      data-slot="tool-card"
      data-status={item.status}
      data-kind={item.toolKind}
      open={open}
      onOpenChange={setUserOpen}
      className={cn(
        // A failed card wears a FAINT danger tint so it reads at a glance, not the loud outline it
        // used to — the exit code and `failed` label carry the signal, the red stays in the body.
        'min-w-0 overflow-hidden rounded-md border bg-card',
        item.status === 'failed' ? 'border-danger/25' : 'border-border',
      )}
    >
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex min-h-[28px] w-full items-center gap-1.5 px-2.5 py-0.5 text-left text-[13px] enabled:hover:bg-muted"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-90',
            !hasDetail && 'invisible',
          )}
        />
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            'shrink-0 font-semibold',
            busy && 'shimmer',
            item.status === 'declined' && 'text-muted-foreground',
          )}
        >
          {verb}
        </span>
        {detail !== undefined ? (
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{detail}</code>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {busy ? (
            <LoaderCircleIcon role="status" aria-label="Running" className="size-3.5 animate-spin text-soft-foreground" />
          ) : null}
          {item.status === 'failed' ? <span className="text-xs text-muted-foreground">failed</span> : null}
          {item.status === 'declined' ? <span className="text-xs text-soft-foreground">declined</span> : null}
          {item.toolKind === 'execute' && typeof item.exitCode === 'number' ? (
            <span
              data-slot="tool-exit"
              className={cn(
                'rounded-full px-2 py-px font-mono text-[10.5px] font-semibold',
                item.exitCode === 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
              )}
            >
              {item.exitCode}
            </span>
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border bg-card-2">
          {item.error !== undefined && item.error !== '' ? (
            <div data-slot="tool-error" className="px-4 py-3 font-mono text-xs leading-[1.7] whitespace-pre-wrap text-danger">
              {item.error}
            </div>
          ) : null}
          {item.diffs !== undefined && item.diffs.length > 0 ? <InlineDiffPreview diffs={item.diffs} /> : null}
          {item.output !== undefined && item.output !== '' ? (
            <ToolOutput text={item.output} streaming={busy} />
          ) : null}
          {nested.length > 0 ? (
            <div data-slot="tool-nested" className="flex flex-col gap-2 border-l-2 border-border py-2.5 pr-3 pl-3 ml-4 my-2">
              {renderNested?.(nested, cacheKey ?? item.id)}
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** "Explored N files · M searches" — consecutive finished read/search tools, one row,
 *  expandable to the individual cards (mockup `.ctx-group`). */
export function ContextGroup({ group, scope }: { group: ContextGroupBlock; scope?: string }) {
  return (
    <Collapsible data-slot="ctx-group" className="min-w-0">
      <CollapsibleTrigger className="group flex h-[34px] w-full items-center gap-2 rounded-md px-2 -mx-2 text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-90"
        />
        {group.label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-1.5 pt-1.5 pl-4">
          {group.tools.map((tool) => (
            <ToolCard key={tool.id} item={tool} cacheKey={scope !== undefined ? `${scope}:${tool.id}` : undefined} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The legacy tool-streak fold, kept: older finished tool cards collapse under
 *  "▸ N earlier tool calls". The caller renders the folded blocks as children. */
export function ToolStreak({ count, children }: { count: number; children: ReactNode }) {
  return (
    <Collapsible data-slot="tool-streak" className="min-w-0">
      <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md p-0.5 text-left text-xs text-soft-foreground hover:text-muted-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
        />
        {streakLabel(count)}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A persisted run image (served by the cockpit itself — never an external origin). Click to zoom. */
export function ImageItem({ image }: { image: ThreadImage }) {
  return (
    <ZoomableImage
      data-slot="thread-image"
      src={image.url}
      alt={image.name ?? 'image from the agent session'}
      className="max-h-72 max-w-full self-start rounded-lg border border-border"
    />
  )
}

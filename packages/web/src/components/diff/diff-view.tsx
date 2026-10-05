import { ChevronRightIcon } from 'lucide-react'
import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'

import type { DiffStat } from '@open-mercato/cezar-api-client'
import { CommentCount } from '@/components/comment-count'
import { DiffStatLabel } from '@/components/diff-stat'
import { highlight, highlightSync, langForPath, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

import {
  diffRenderMode,
  diffRowCount,
  estimateFileHeight,
  fileKey,
  widestLineChars,
} from './diff-scroll'
import { ImagePreview, shouldPreviewImage } from './image-preview'
import {
  AddCommentButton,
  anchorForLine,
  anchorKey,
  LineCommentsContext,
  FileLinesContext,
  LineCommentThread,
  markClass,
  rangeTarget,
  tapToComment,
  useLineComments,
  type FileLines,
  type LineCommentsApi,
  type LineSelection,
} from './line-comments'

import {
  buildSplitRows,
  buildUnifiedRows,
  contextGaps,
  contextLinesForGap,
  parsePatch,
  type ContextGap,
  type DiffCell,
  type ExpandedGaps,
  type Hunk,
  type HunkLine,
  type SplitRow,
  type UnifiedRow,
} from './parse-patch'
import type {
  DiffFileChange,
  DiffLineAnchor,
  DiffLineComment,
  DiffLineEnd,
  DiffProps,
  DiffRevealTarget,
} from './types'
import { overlaySegments } from './word-diff'

/**
 * The default `<Diff>` renderer (R5 Step 1.4) — our own implementation of the facade
 * contract, loaded lazily by `diff.tsx`. Unified and split layouts over the pure row
 * builders in `parse-patch.ts`, word-level marks from `word-diff.ts`, syntax highlighting
 * through the ONE Shiki singleton (`lib/highlighter.ts` — the same instance the chat's code
 * blocks use; a second highlighter anywhere is a bug by that module's contract).
 *
 * All color goes through the theme tokens: `--diff-*` tints for line backgrounds and word
 * marks, `--syn-*` (via the singleton's theme) for code, status tokens for ± numbers.
 */

/** Past this many patch lines a file skips syntax highlighting — plaintext beats jank. */
const HIGHLIGHT_MAX_LINES = 1500

/** Stable empty map, so a file with no expanded gaps keeps prop identity across renders. */
const NO_GAPS: ExpandedGaps = new Map()

/**
 * The card element for a path, matched on `dataset` rather than an attribute selector: a
 * repository path may contain any of `"`, `[`, `]` or a backslash, and `CSS.escape` — the
 * only correct way to embed one in a selector — is absent in some DOM implementations.
 * Comparing the property sidesteps both problems.
 */
export function findFileElement(root: ParentNode | null, path: string): HTMLElement | undefined {
  if (!root) return undefined
  for (const element of root.querySelectorAll<HTMLElement>('[data-slot="diff-file"]')) {
    if (element.dataset.path === path) return element
  }
  return undefined
}

/** The comment card with this id, else the row that counts `line` on `side`, within `path`. */
export function findRevealElement(root: ParentNode | null, target: DiffRevealTarget): HTMLElement | undefined {
  const card = findFileElement(root, target.path)
  if (!card) return undefined
  if (target.commentId !== undefined) {
    for (const element of card.querySelectorAll<HTMLElement>('[data-slot="diff-line-comment"]')) {
      if (element.dataset.commentId === target.commentId) return element
    }
  }
  if (target.line === undefined) return undefined
  const wanted = String(target.line)
  for (const row of card.querySelectorAll<HTMLElement>('[data-slot="diff-line"], [data-slot="diff-cell"]')) {
    if ((target.side === 'old' ? row.dataset.oldLine : row.dataset.newLine) === wanted) return row
  }
  return undefined
}

/** A brief highlight on what a reveal landed on — the eye finds it in a screen of code. */
function flash(element: HTMLElement) {
  element.dataset.flash = 'true'
  setTimeout(() => {
    delete element.dataset.flash
  }, 1600)
}

export function DiffView({
  files,
  mode = 'unified',
  wrap = false,
  loadFileText,
  imageSrc,
  onOpenInApp,
  viewRef,
  comments,
  onAddComment,
  onEditComment,
  onRemoveComment,
  className,
}: DiffProps) {
  const stat: DiffStat = useMemo(
    () => ({
      adds: files.reduce((sum, file) => sum + file.adds, 0),
      dels: files.reduce((sum, file) => sum + file.dels, 0),
      files: files.length,
    }),
    [files],
  )

  // PER-FILE STATE LIVES HERE, not in the card. Virtualization unmounts off-screen cards, and
  // a collapsed file or an expanded context gap must survive scrolling away and back — state
  // inside the card would silently reset. Keyed by `fileKey`, so a refetch that returns the
  // same files (the Changes tab polls every 4s while a run is active) keeps both.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedByFile, setExpandedByFile] = useState<ReadonlyMap<string, ExpandedGaps>>(() => new Map())

  const toggleFile = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const expandGap = useCallback(
    async (file: DiffFileChange, gap: ContextGap) => {
      if (!loadFileText) return
      const text = await loadFileText(file.path)
      if (text === null) return // unavailable (binary/too large/deleted) — the gap stays honest
      const lines = contextLinesForGap(gap, text.split('\n'))
      setExpandedByFile((previous) => {
        const key = fileKey(file)
        const next = new Map(previous)
        return next.set(key, new Map(previous.get(key) ?? NO_GAPS).set(gap.beforeHunk, lines))
      })
    },
    [loadFileText],
  )

  // The open line-comment editor lives here for the same reason as `collapsed`: its row can be
  // virtualized away and back while the user is still deciding what to write.
  const [editing, setEditing] = useState<LineCommentsApi['editing']>(null)
  const pendingText = useRef(new Map<string, string>()).current
  const focusRequest = useRef<string | null>(null)
  // A range being dragged out with the "+". The dragged file's line list rides a ref: the release
  // handler needs it, and it never has to re-render anything.
  const [selection, setSelection] = useState<LineSelection | null>(null)
  // Mirrored synchronously: the release handler reads THIS, so a fast release cannot finish on a
  // render that had not yet caught up with the last row the pointer entered.
  const selectionRef = useRef<LineSelection | null>(null)
  const selectionLines = useRef<readonly HunkLine[]>([])
  const selecting = selection !== null
  const editingRef = useRef(editing)
  editingRef.current = editing
  // Where focus goes back to when the editor closes (Comment, Save, Cancel, Escape): the control
  // that opened it, or — when that one is gone, as an Edit button is once its card turns into the
  // editor — the comment's card. Without this, focus fell to <body> and a keyboard user restarted
  // from the top of the page after every comment.
  const returnFocus = useRef<{ element: HTMLElement | null; commentId?: string }>({ element: null })
  const rootForFocus = useRef<HTMLDivElement | null>(null)
  const captureOpener = (commentId?: string) => {
    const active = document.activeElement
    returnFocus.current = {
      element: active instanceof HTMLElement && rootForFocus.current?.contains(active) ? active : null,
      ...(commentId ? { commentId } : {}),
    }
  }
  const restoreFocus = () => {
    const { element, commentId } = returnFocus.current
    returnFocus.current = { element: null }
    // After the commit that removed the editor, so the target exists (or is known to be gone).
    setTimeout(() => {
      if (element?.isConnected) {
        element.focus({ preventScroll: true })
        return
      }
      if (commentId === undefined) return
      for (const card of rootForFocus.current?.querySelectorAll<HTMLElement>('[data-slot="diff-line-comment"]') ?? []) {
        if (card.dataset.commentId === commentId) {
          card.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
          return
        }
      }
    }, 0)
  }
  const focusHelpers = useRef({ captureOpener, restoreFocus })
  focusHelpers.current = { captureOpener, restoreFocus }

  const openEditor = useCallback(
    (anchor: DiffLineAnchor, excerpt: string, start?: DiffLineEnd, stretch = false) => {
      const threadKey = anchorKey(anchor)
      const key = start ? `${threadKey}\u0000${start.side}:${start.line}` : threadKey
      // Stretching an open range must not lose what was already typed into it. Only a STRETCH
      // carries the text: opening a fresh editor elsewhere starts empty (the old one's text stays
      // filed under its own line, for when the user comes back to it).
      const previous = editingRef.current
      if (stretch && previous && previous.commentId === undefined && previous.key !== key) {
        const typed = pendingText.get(previous.key)
        if (typed !== undefined) {
          pendingText.set(key, typed)
          pendingText.delete(previous.key)
        }
      }
      // A removed line's number belongs to the pre-rename file, so it travels with its path.
      const oldPath =
        anchor.side === 'old' || start?.side === 'old' ? files.find((file) => file.path === anchor.path)?.oldPath : undefined
      focusRequest.current = key
      if (!stretch) focusHelpers.current.captureOpener()
      setEditing({ key, threadKey, anchor, excerpt, ...(start ? { start } : {}), ...(oldPath ? { oldPath } : {}) })
    },
    [files, pendingText],
  )

  // Releasing the button ANYWHERE ends the drag — over a row, between rows, or off the diff.
  useEffect(() => {
    if (!selecting) return
    const finish = () => {
      const done = selectionRef.current
      selectionRef.current = null
      setSelection(null)
      if (!done) return
      const target = rangeTarget(done.path, selectionLines.current, done.from, done.to)
      if (target) openEditor(target.anchor, target.excerpt, target.start)
    }
    window.addEventListener('mouseup', finish)
    return () => window.removeEventListener('mouseup', finish)
  }, [openEditor, selecting])
  const commentsApi = useMemo((): LineCommentsApi | null => {
    if (!onAddComment && (comments?.length ?? 0) === 0) return null
    const byKey = new Map<string, DiffLineComment[]>()
    for (const comment of comments ?? []) {
      const key = anchorKey(comment)
      byKey.set(key, [...(byKey.get(key) ?? []), comment])
    }
    return {
      comments: comments ?? [],
      byKey,
      editing,
      selection,
      canAdd: onAddComment !== undefined,
      open: openEditor,
      beginSelect: (path, order, lines) => {
        selectionLines.current = lines
        selectionRef.current = { path, from: order, to: order }
        setSelection(selectionRef.current)
      },
      extendSelect: (path, order) => {
        const current = selectionRef.current
        if (current === null || current.path !== path || current.to === order) return
        selectionRef.current = { ...current, to: order }
        setSelection(selectionRef.current)
      },
      edit: onEditComment
        ? (comment: DiffLineComment) => {
            focusRequest.current = `edit:${comment.id}`
            focusHelpers.current.captureOpener(comment.id)
            setEditing({
              key: `edit:${comment.id}`,
              threadKey: anchorKey(comment),
              anchor: comment,
              ...(comment.start ? { start: comment.start } : {}),
              excerpt: '',
              commentId: comment.id,
              initial: comment.body,
            })
          }
        : undefined,
      cancel: () => {
        setEditing(null)
        focusHelpers.current.restoreFocus()
      },
      // A refused comment keeps its editor (and its text) open rather than vanishing unsaved.
      submit: (comment) => {
        if (onAddComment?.(comment) === false) return false
        setEditing(null)
        focusHelpers.current.restoreFocus()
        return true
      },
      update: (id, body) => {
        if (onEditComment?.(id, body) === false) return false
        setEditing(null)
        focusHelpers.current.restoreFocus()
        return true
      },
      remove: onRemoveComment,
      pendingText,
      focusRequest,
    }
  }, [comments, editing, onAddComment, onEditComment, onRemoveComment, openEditor, pendingText, selection])

  const rowCount = useMemo(() => diffRowCount(files), [files])
  // The `?diff=` override is a measurement/debugging seam, not reactive state — read once so
  // this module stays router-free (it renders in tests and in the repo view alike).
  const [search] = useState(() => (typeof window === 'undefined' ? '' : window.location.search))
  const renderMode = diffRenderMode(search, rowCount)

  const scrollElRef = useRef<HTMLElement | null>(null)
  const virtualizerRef = useRef<VirtualizerHandle | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useImperativeHandle(
    viewRef,
    () => {
      const scrollToPath = (path: string) => {
        const index = files.findIndex((file) => file.path === path)
        if (index === -1) return
        const handle = virtualizerRef.current
        // Virtualized: the target may not be mounted, so the scroll goes through the index.
        // Reserve the sticky chrome above the file in both modes. Flat jumps must be
        // immediate: lazy content measurement can invalidate a smooth-scroll destination.
        const root = rootRef.current
        const offset = root ? Number.parseFloat(getComputedStyle(root).scrollMarginTop) || 0 : 0
        if (handle) handle.scrollToIndex(index, { align: 'start', offset: -offset })
        else findFileElement(root, path)?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
      }
      return {
        scrollToPath: (path: string) => scrollToPath(path),
        reveal: (target) => {
          const file = files.find((candidate) => candidate.path === target.path)
          if (!file) return
          // A collapsed card has no rows to find.
          setCollapsed((previous) => {
            if (!previous.has(fileKey(file))) return previous
            const next = new Set(previous)
            next.delete(fileKey(file))
            return next
          })
          scrollToPath(target.path)
          // The rows may not exist yet — a virtualized card mounts after the scroll, an expanded
          // one after the next commit — so look for a few frames before settling for the file.
          let frames = 0
          const look = () => {
            const element = findRevealElement(rootRef.current, target)
            if (element) {
              const scroller = scrollElRef.current
              const handle = virtualizerRef.current
              if (scroller && handle) {
                // Cancel the virtualizer's pending file jump with another virtualizer scroll.
                // A DOM scroll races its measurement corrections and can leave a deep comment
                // off screen even though we found and flashed the right element.
                const box = element.getBoundingClientRect()
                const margin = Number.parseFloat(getComputedStyle(element).scrollMarginBottom) || 0
                handle.scrollTo(scroller.scrollTop + box.top - scroller.getBoundingClientRect().top
                  - (scroller.clientHeight - margin - box.height) / 2)
              } else {
                // An immediate jump lets content-visibility finish measuring before the next
                // paint; a smooth jump can stop at the off-screen placeholder's old position.
                element.scrollIntoView?.({ block: 'center', behavior: 'instant' })
              }
              flash(element)
              return
            }
            if (++frames < 30) requestAnimationFrame(look)
          }
          requestAnimationFrame(look)
        },
      }
    },
    [files],
  )

  const card = (file: DiffFileChange) => {
    const key = fileKey(file)
    return (
      <DiffFileCard
        file={file}
        open={!collapsed.has(key)}
        onToggle={() => toggleFile(key)}
        expanded={expandedByFile.get(key) ?? NO_GAPS}
        onExpand={(gap) => void expandGap(file, gap)}
        mode={mode}
        wrap={wrap}
        canExpand={loadFileText !== undefined}
        imageSrc={imageSrc}
        onOpenInApp={onOpenInApp}
      />
    )
  }

  return (
    <LineCommentsContext.Provider value={commentsApi}>
    <div
      ref={(el) => {
        rootRef.current = el
        rootForFocus.current = el
        if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
      }}
      data-slot="diff"
      data-mode={mode}
      className={cn('flex min-w-0 flex-col scroll-mt-[var(--diff-sticky-top,0px)]', className)}
    >
      <p data-slot="diff-totals" className="flex items-center gap-2 px-1 pb-3 text-xs text-muted-foreground">
        <span>
          {stat.files} {stat.files === 1 ? 'file' : 'files'} changed
        </span>
        <DiffStatLabel stat={stat} />
      </p>
      {renderMode === 'virtual' ? (
        <VirtualFiles files={files} handleRef={virtualizerRef} scrollElRef={scrollElRef} card={card} />
      ) : (
        <div data-slot="diff-files" data-virtualized="false">
          {files.map((file) => (
            // content-visibility skips style/layout/paint for off-screen cards; the
            // intrinsic-size hint keeps the scrollbar stable before a skipped card is first
            // measured. The card spacing that used to be the column's `gap` is this wrapper's
            // bottom padding, so flat and virtualized modes measure identically.
            <div
              key={fileKey(file)}
              data-slot="diff-file-slot"
              style={{ containIntrinsicBlockSize: `auto ${estimateFileHeight(file)}px` }}
              className="pb-3 [content-visibility:auto]"
            >
              {card(file)}
            </div>
          ))}
        </div>
      )}
    </div>
    </LineCommentsContext.Provider>
  )
}

/**
 * The file cards through virtua, on the app shell's scroller (`[data-slot="main"]`) — the one
 * scroll owner, exactly as the thread does it. No `shift`: a diff only ever changes in place,
 * so start-anchored offsets stay correct.
 *
 * No measurement cache (the thread's `CacheSnapshot` trick): virtua's snapshot is only valid
 * at the item count it was taken at, and a diff's file list changes under an active run's
 * 4s poll. Re-estimating a few dozen cards costs nothing next to mis-applying a stale one.
 */
function VirtualFiles({
  files,
  handleRef,
  scrollElRef,
  card,
}: {
  files: DiffFileChange[]
  handleRef: React.RefObject<VirtualizerHandle | null>
  scrollElRef: React.RefObject<HTMLElement | null>
  card: (file: DiffFileChange) => React.ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // virtua needs the distance between the scroller's content start and the virtualizer (the
  // run header, toolbar and totals line above it). Measured, not assumed — header height
  // varies by breakpoint and content. A stale value only shifts the overscan window
  // (buffered), so re-measuring on viewport resize is enough.
  //
  // The scroller is resolved from THIS component's own element, not handed down from the
  // parent's ref callback: React attaches refs child-first, so a parent element's callback
  // runs AFTER this layout effect: the ref would still be null here, `measure()` would bail,
  // and with stable deps it would never run again — pinning startMargin at 0 forever.
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current
      const scroller = scrollElRef.current
      if (!container || !scroller) return
      setStartMargin(
        Math.max(
          0,
          Math.round(
            container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
          ),
        ),
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [scrollElRef])

  return (
    <div
      ref={(el) => {
        containerRef.current = el
        if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
      }}
      data-slot="diff-files"
      data-virtualized="true"
    >
      <Virtualizer ref={handleRef} scrollRef={scrollElRef} startMargin={startMargin}>
        {files.map((file) => (
          <div key={fileKey(file)} data-slot="diff-file-slot" className="pb-3">
            {card(file)}
          </div>
        ))}
      </Virtualizer>
    </div>
  )
}

const STATUS_BADGE: Partial<Record<DiffFileChange['status'], string>> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
}

/**
 * One file: sticky header (path, status, ±, collapse) over the row grid.
 *
 * Fully controlled — `open` and `expanded` live in {@link DiffView} so they survive the
 * unmount virtualization performs when this card scrolls off screen.
 */
function DiffFileCard({
  file,
  open,
  onToggle,
  expanded,
  onExpand,
  mode,
  wrap,
  canExpand,
  imageSrc,
  onOpenInApp,
}: {
  file: DiffFileChange
  open: boolean
  onToggle: () => void
  expanded: ExpandedGaps
  onExpand: (gap: ContextGap) => void
  mode: 'unified' | 'split'
  wrap: boolean
  canExpand: boolean
  imageSrc?: (path: string) => string
  onOpenInApp?: (path: string) => void
}) {
  const badge = STATUS_BADGE[file.status]
  const commentCount = useLineComments()?.comments.filter((comment) => comment.path === file.path).length ?? 0
  return (
    <section
      data-slot="diff-file"
      data-path={file.path}
      className="min-w-0 scroll-mt-[var(--diff-sticky-top,0px)] overflow-clip rounded-md border border-border bg-card"
    >
      {/* Sticky within the consumer's scroll container — the reader always knows which file.
          The offset is a consumer-set CSS var so the file header parks BELOW a sticky page
          header (Git / run header) rather than colliding with it; `z-10` keeps it beneath the
          page header's higher layer. Defaults to 0 for consumers without a sticky header. */}
      <header className="sticky top-[var(--diff-sticky-top,0px)] z-10 rounded-t-md border-b border-border/50 bg-card">
        <button
          type="button"
          data-slot="diff-file-header"
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
        >
          <ChevronRightIcon
            className={cn('size-3.5 shrink-0 text-soft-foreground transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
          <span data-slot="diff-file-path" className="min-w-0 truncate font-mono text-xs font-medium">
            {file.oldPath ? (
              <>
                <span className="text-soft-foreground">{file.oldPath} → </span>
                {file.path}
              </>
            ) : (
              file.path
            )}
          </span>
          {badge ? (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          ) : null}
          {file.image ? (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              image
            </span>
          ) : file.binary ? (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              binary
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <CommentCount count={commentCount} />
            <DiffStatLabel stat={{ adds: file.adds, dels: file.dels, files: 1 }} className="text-[11px]" />
          </span>
        </button>
      </header>
      {open ? (
        <DiffFileBody
          file={file}
          expanded={expanded}
          onExpand={onExpand}
          mode={mode}
          wrap={wrap}
          canExpand={canExpand}
          imageSrc={imageSrc}
          onOpenInApp={onOpenInApp}
        />
      ) : null}
    </section>
  )
}

function DiffFileBody({
  file,
  expanded,
  onExpand,
  mode,
  wrap,
  canExpand,
  imageSrc,
  onOpenInApp,
}: {
  file: DiffFileChange
  expanded: ExpandedGaps
  onExpand: (gap: ContextGap) => void
  mode: 'unified' | 'split'
  wrap: boolean
  canExpand: boolean
  imageSrc?: (path: string) => string
  onOpenInApp?: (path: string) => void
}) {
  const parsed = useMemo(() => parsePatch(file.patch), [file.patch])
  // The trailing (after-last-hunk) region has an unknown length — only offer it when a
  // loader can actually materialize it, and never for fully-new or deleted files.
  const expandable = canExpand && file.status !== 'added' && file.status !== 'deleted'
  const gaps = useMemo(() => contextGaps(parsed.hunks, expandable), [parsed.hunks, expandable])

  // One ordered list of every displayed line (hunks + expanded context) — the highlighting
  // unit. Both layouts reference the same HunkLine objects, so tokens map by identity.
  const lineList = useMemo(() => {
    const out: HunkLine[] = []
    parsed.hunks.forEach((hunk, index) => {
      const expansion = expanded.get(index)
      if (expansion) out.push(...expansion)
      out.push(...hunk.lines)
    })
    const trailing = expanded.get(parsed.hunks.length)
    if (trailing) out.push(...trailing)
    return out
  }, [parsed.hunks, expanded])
  const lineIndex = useMemo(() => new Map(lineList.map((line, index) => [line, index])), [lineList])
  const tokens = useFileTokens(file.path, lineList)

  // Which rows a range or a comment covers, by position in `lineList`. Recomputed when comments,
  // the open editor or a drag change — never per keystroke (the editor's text is not state).
  const commentsApi = useLineComments()
  const fileLines = useMemo((): FileLines | null => {
    if (!commentsApi) return null
    const orderByKey = new Map<string, number>()
    lineList.forEach((line, order) => {
      const at = anchorForLine(file.path, line)
      if (at) orderByKey.set(anchorKey(at), order)
    })
    const orderOf = (end: DiffLineEnd) => orderByKey.get(anchorKey({ path: file.path, side: end.side, line: end.line }))
    const marks = new Map<number, 'selected' | 'commented'>()
    const mark = (a: number, b: number, kind: 'selected' | 'commented') => {
      for (let order = Math.min(a, b); order <= Math.max(a, b); order++) {
        if (kind === 'selected' || !marks.has(order)) marks.set(order, kind)
      }
    }
    const markEnds = (end: DiffLineEnd, start: DiffLineEnd | undefined, kind: 'selected' | 'commented') => {
      const to = orderOf(end)
      if (to === undefined) return
      mark(start ? (orderOf(start) ?? to) : to, to, kind)
    }
    for (const comment of commentsApi.comments) {
      if (comment.path === file.path) markEnds(comment, comment.start, 'commented')
    }
    const { editing, selection } = commentsApi
    if (editing && editing.anchor.path === file.path) markEnds(editing.anchor, editing.start, 'selected')
    if (selection && selection.path === file.path) mark(selection.from, selection.to, 'selected')
    return { path: file.path, lines: lineList, orderOf: lineIndex, markAt: (order) => marks.get(order) }
  }, [commentsApi, file.path, lineList, lineIndex])

  const rows = useMemo(
    () => (mode === 'unified' ? buildUnifiedRows(parsed.hunks, gaps, expanded) : null),
    [mode, parsed.hunks, gaps, expanded],
  )
  const splitRows = useMemo(
    () => (mode === 'split' ? buildSplitRows(parsed.hunks, gaps, expanded) : null),
    [mode, parsed.hunks, gaps, expanded],
  )

  // The horizontal-scroll floor for `content-visibility` (see `widestLineChars`). Unified
  // no-wrap only: that is the one layout where the body scrolls horizontally on the widest
  // LINE. Wrapped rows never exceed the box, and split mode's two columns are a grid sized by
  // the container, so neither can have its scrollWidth pulled in by a size-contained row.
  // `7rem` is the gutters (old/new line numbers + marker + the content's right padding).
  const widthFloor = useMemo(
    () =>
      mode === 'unified' && !wrap
        ? { minInlineSize: `calc(${widestLineChars(file.patch)}ch + 7rem)` }
        : undefined,
    [mode, wrap, file.patch],
  )

  // Only images with no text diff to lose take the preview branch — see `shouldPreviewImage`.
  // An SVG git reports as text keeps its rows below, exactly as `DiffFallback` renders it.
  if (shouldPreviewImage(file)) {
    return <ImagePreview file={file} imageSrc={imageSrc} onOpenInApp={onOpenInApp} />
  }
  if (file.binary) {
    return <Note>Binary file — no text diff.</Note>
  }
  if (parsed.hunks.length === 0) {
    return <Note>{parsed.truncated ? 'Patch truncated by the server.' : 'No content changes (metadata only).'}</Note>
  }

  const tokensFor = (line: HunkLine): SynToken[] | null => {
    if (!tokens) return null
    const index = lineIndex.get(line)
    return index === undefined ? null : (tokens[index] ?? null)
  }

  return (
    <div
      data-slot="diff-file-body"
      data-wrap={wrap || undefined}
      className={cn('py-1 font-mono text-xs leading-[1.7]', !wrap && 'overflow-x-auto')}
    >
      {/* Every row gets `content-visibility: auto` — the tier that bounds the cost of ONE
          enormous file, which card-level virtualization cannot (its rows are a single item).
          Applied through a child selector rather than a wrapper element per row: an extra
          node per line is the very cost this is here to remove. The intrinsic-size hint is
          DIFF_ROW_ESTIMATE_PX; `auto` lets a once-rendered row remember its real height.
          `min-inline-size` is the horizontal-scroll floor — see `widestLineChars`. */}
      <FileLinesContext.Provider value={fileLines}>
      <div
        data-slot="diff-rows"
        style={widthFloor}
        className="[&>*]:[contain-intrinsic-block-size:auto_20px] [&>*]:[content-visibility:auto]"
      >
        {rows
          ? rows.map((row, index) => (
              <UnifiedRowView key={index} path={file.path} row={row} wrap={wrap} tokensFor={tokensFor} onExpand={expandable ? onExpand : undefined} />
            ))
          : null}
        {splitRows
          ? splitRows.map((row, index) => (
              <SplitRowView key={index} path={file.path} row={row} wrap={wrap} tokensFor={tokensFor} onExpand={expandable ? onExpand : undefined} />
            ))
          : null}
      </div>
      </FileLinesContext.Provider>
      {parsed.truncated ? <Note>Patch truncated by the server — counts above remain exact.</Note> : null}
    </div>
  )
}

/** Load-and-cache this file's syntax tokens through the shared singleton (never rejects). */
function useFileTokens(path: string, lineList: HunkLine[]): SynToken[][] | null {
  const text = useMemo(
    () => (lineList.length > HIGHLIGHT_MAX_LINES ? null : lineList.map((line) => line.text).join('\n')),
    [lineList],
  )
  const lang = useMemo(() => langForPath(path), [path])
  const [loaded, setLoaded] = useState<{ text: string; tokens: SynToken[][] } | null>(null)
  useEffect(() => {
    if (text === null || lang === null) return
    let cancelled = false
    void highlight(text, lang).then((result) => {
      if (!cancelled) setLoaded({ text, tokens: result.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [text, lang])
  if (text === null || lang === null) return null
  if (loaded?.text === text) return loaded.tokens
  return highlightSync(text, lang)?.tokens ?? null
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-2.5 text-xs text-soft-foreground">{children}</p>
}

// ---- rows ---------------------------------------------------------------------------------

const LINE_BG: Record<HunkLine['kind'], string | undefined> = {
  add: 'bg-diff-add',
  del: 'bg-diff-del',
  context: undefined,
}
const MARKER: Record<HunkLine['kind'], string> = { add: '+', del: '−', context: ' ' }
/** What a `reveal` flashes: an inset accent ring, gone after a moment (see `flash`). */
const FLASH = 'transition-shadow duration-500 data-[flash=true]:ring-2 data-[flash=true]:ring-inset data-[flash=true]:ring-primary'

function HunkHeaderRow({ hunk }: { hunk: Hunk }) {
  return (
    <div data-slot="diff-hunk" className="bg-muted/40 px-4 py-0.5 whitespace-pre text-soft-foreground">
      {hunk.header}
    </div>
  )
}

/** "⋯ N unchanged lines" — a button when expansion is wired, a separator otherwise. */
function GapRow({ gap, onExpand }: { gap: ContextGap; onExpand?: (gap: ContextGap) => void }) {
  const label = gap.count === undefined ? '⋯ unchanged lines to end of file' : `⋯ ${gap.count} unchanged ${gap.count === 1 ? 'line' : 'lines'}`
  if (!onExpand) {
    return (
      <div data-slot="diff-gap" className="border-y border-border/40 bg-muted/20 px-4 py-0.5 text-[11px] text-soft-foreground">
        {label}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-slot="diff-gap"
      onClick={() => onExpand(gap)}
      className="block w-full border-y border-border/40 bg-muted/20 px-4 py-0.5 text-left text-[11px] text-soft-foreground hover:bg-muted/50 hover:text-foreground"
    >
      {label} — expand
    </button>
  )
}

/** A line's content: syntax tokens × word marks, empty lines kept one row tall. */
function LineContent({ cell, tokens, wrap }: { cell: DiffCell; tokens: SynToken[] | null; wrap: boolean }) {
  const segments = overlaySegments(tokens, cell.spans, cell.line.text)
  const markClass = cell.line.kind === 'add' ? 'bg-diff-add-strong' : 'bg-diff-del-strong'
  return (
    <span className={cn('min-w-0 flex-1 pr-4', wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre')}>
      {segments.map((segment, index) => (
        <span
          key={index}
          data-word={segment.changed ? cell.line.kind : undefined}
          style={segment.color !== undefined ? { color: segment.color } : undefined}
          className={segment.changed ? cn('rounded-[2px]', markClass) : undefined}
        >
          {segment.text}
        </span>
      ))}
      {cell.line.text === '' ? ' ' : ''}
    </span>
  )
}

function Gutter({ value }: { value: number | undefined }) {
  return (
    <span className="w-10 shrink-0 pr-2 text-right text-soft-foreground/70 tabular-nums select-none">
      {value ?? ''}
    </span>
  )
}

function UnifiedRowView({
  path,
  row,
  wrap,
  tokensFor,
  onExpand,
}: {
  path: string
  row: UnifiedRow
  wrap: boolean
  tokensFor: (line: HunkLine) => SynToken[] | null
  onExpand?: (gap: ContextGap) => void
}) {
  const comments = useLineComments()
  const fileLines = useContext(FileLinesContext)
  if (row.type === 'hunk') return <HunkHeaderRow hunk={row.hunk} />
  if (row.type === 'gap') return <GapRow gap={row.gap} onExpand={onExpand} />
  const { line } = row.cell
  const anchor = anchorForLine(path, line)
  const tap = tapToComment(comments, anchor, line.text)
  const order = fileLines?.orderOf.get(line)
  const mark = order === undefined ? undefined : fileLines?.markAt(order)
  // A fragment, not a wrapper: each row stays a direct child of `diff-rows`, which is what its
  // per-row `content-visibility` selector targets.
  return (
    <>
      <div
        data-slot="diff-line"
        data-line={line.kind}
        data-old-line={line.oldLine}
        data-new-line={line.newLine}
        data-mark={mark}
        {...tap}
        onMouseEnter={
          comments?.selection && order !== undefined ? () => comments.extendSelect(path, order) : undefined
        }
        className={cn('group/line flex', LINE_BG[line.kind], markClass(mark), FLASH)}
      >
        <Gutter value={line.oldLine} />
        <Gutter value={line.newLine} />
        <span className="relative w-4 shrink-0 text-soft-foreground select-none">
          {MARKER[line.kind]}
          <AddCommentButton anchor={anchor} excerpt={line.text} line={line} />
        </span>
        <LineContent cell={row.cell} tokens={tokensFor(line)} wrap={wrap} />
      </div>
      <LineCommentThread anchors={[anchor]} />
    </>
  )
}

function SplitRowView({
  path,
  row,
  wrap,
  tokensFor,
  onExpand,
}: {
  path: string
  row: SplitRow
  wrap: boolean
  tokensFor: (line: HunkLine) => SynToken[] | null
  onExpand?: (gap: ContextGap) => void
}) {
  if (row.type === 'hunk') return <HunkHeaderRow hunk={row.hunk} />
  if (row.type === 'gap') return <GapRow gap={row.gap} onExpand={onExpand} />
  const leftAnchor = row.left ? anchorForLine(path, row.left.line) : undefined
  const rightAnchor = row.right ? anchorForLine(path, row.right.line) : undefined
  return (
    <>
      <div data-slot="diff-pair" className="grid grid-cols-2">
        <SplitCell cell={row.left} anchor={leftAnchor} side="old" tokensFor={tokensFor} wrap={wrap} />
        <SplitCell cell={row.right} anchor={rightAnchor} side="new" tokensFor={tokensFor} wrap={wrap} />
      </div>
      <LineCommentThread anchors={[leftAnchor, rightAnchor]} />
    </>
  )
}

function SplitCell({
  cell,
  anchor,
  side,
  tokensFor,
  wrap,
}: {
  cell?: DiffCell
  anchor: DiffLineAnchor | undefined
  side: 'old' | 'new'
  tokensFor: (line: HunkLine) => SynToken[] | null
  wrap: boolean
}) {
  const comments = useLineComments()
  const fileLines = useContext(FileLinesContext)
  if (!cell) {
    // The other side has no counterpart line — an honest hatch-free blank.
    return <div data-slot="diff-cell-empty" className={cn('bg-muted/20', side === 'new' && 'border-l border-border/40')} />
  }
  const { line } = cell
  const order = fileLines?.orderOf.get(line)
  const mark = order === undefined ? undefined : fileLines?.markAt(order)
  return (
    <div
      data-slot="diff-cell"
      data-line={line.kind}
      data-old-line={line.oldLine}
      data-new-line={line.newLine}
      data-mark={mark}
      {...tapToComment(comments, anchor, line.text)}
      onMouseEnter={
        comments?.selection && order !== undefined && anchor ? () => comments.extendSelect(anchor.path, order) : undefined
      }
      className={cn(
        'group/line flex min-w-0 overflow-x-auto',
        LINE_BG[line.kind],
        side === 'new' && 'border-l border-border/40',
        markClass(mark),
        FLASH,
      )}
    >
      <Gutter value={side === 'old' ? line.oldLine : line.newLine} />
      <span className="relative w-4 shrink-0 text-soft-foreground select-none">
        {MARKER[line.kind]}
        <AddCommentButton anchor={anchor} excerpt={line.text} line={line} />
      </span>
      <LineContent cell={cell} tokens={tokensFor(line)} wrap={wrap} />
    </div>
  )
}

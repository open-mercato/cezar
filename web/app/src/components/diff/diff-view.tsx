import { ChevronRightIcon } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'

import type { DiffStat } from '@/api/types'
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
import type { DiffFileChange, DiffProps } from './types'
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

export function DiffView({
  files,
  mode = 'unified',
  wrap = false,
  loadFileText,
  imageSrc,
  onOpenInApp,
  viewRef,
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
    () => ({
      scrollToPath: (path: string) => {
        const index = files.findIndex((file) => file.path === path)
        if (index === -1) return
        const handle = virtualizerRef.current
        // Virtualized: the target may not be mounted, so the scroll goes through the index.
        // Flat: the element is always there, and scrollIntoView keeps the smooth behavior.
        if (handle) handle.scrollToIndex(index, { align: 'start' })
        else findFileElement(rootRef.current, path)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
    }),
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
    <div
      ref={(el) => {
        rootRef.current = el
        if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
      }}
      data-slot="diff"
      data-mode={mode}
      className={cn('flex min-w-0 flex-col', className)}
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
  return (
    <section
      data-slot="diff-file"
      data-path={file.path}
      className="min-w-0 overflow-clip rounded-md border border-border bg-card"
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
          <span className="ml-auto shrink-0">
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
      <div
        data-slot="diff-rows"
        style={widthFloor}
        className="[&>*]:[contain-intrinsic-block-size:auto_20px] [&>*]:[content-visibility:auto]"
      >
        {rows
          ? rows.map((row, index) => (
              <UnifiedRowView key={index} row={row} wrap={wrap} tokensFor={tokensFor} onExpand={expandable ? onExpand : undefined} />
            ))
          : null}
        {splitRows
          ? splitRows.map((row, index) => (
              <SplitRowView key={index} row={row} wrap={wrap} tokensFor={tokensFor} onExpand={expandable ? onExpand : undefined} />
            ))
          : null}
      </div>
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
  row,
  wrap,
  tokensFor,
  onExpand,
}: {
  row: UnifiedRow
  wrap: boolean
  tokensFor: (line: HunkLine) => SynToken[] | null
  onExpand?: (gap: ContextGap) => void
}) {
  if (row.type === 'hunk') return <HunkHeaderRow hunk={row.hunk} />
  if (row.type === 'gap') return <GapRow gap={row.gap} onExpand={onExpand} />
  const { line } = row.cell
  return (
    <div data-slot="diff-line" data-line={line.kind} className={cn('flex', LINE_BG[line.kind])}>
      <Gutter value={line.oldLine} />
      <Gutter value={line.newLine} />
      <span className="w-4 shrink-0 text-soft-foreground select-none">{MARKER[line.kind]}</span>
      <LineContent cell={row.cell} tokens={tokensFor(line)} wrap={wrap} />
    </div>
  )
}

function SplitRowView({
  row,
  wrap,
  tokensFor,
  onExpand,
}: {
  row: SplitRow
  wrap: boolean
  tokensFor: (line: HunkLine) => SynToken[] | null
  onExpand?: (gap: ContextGap) => void
}) {
  if (row.type === 'hunk') return <HunkHeaderRow hunk={row.hunk} />
  if (row.type === 'gap') return <GapRow gap={row.gap} onExpand={onExpand} />
  return (
    <div data-slot="diff-pair" className="grid grid-cols-2">
      <SplitCell cell={row.left} side="old" tokensFor={tokensFor} wrap={wrap} />
      <SplitCell cell={row.right} side="new" tokensFor={tokensFor} wrap={wrap} />
    </div>
  )
}

function SplitCell({
  cell,
  side,
  tokensFor,
  wrap,
}: {
  cell?: DiffCell
  side: 'old' | 'new'
  tokensFor: (line: HunkLine) => SynToken[] | null
  wrap: boolean
}) {
  if (!cell) {
    // The other side has no counterpart line — an honest hatch-free blank.
    return <div data-slot="diff-cell-empty" className={cn('bg-muted/20', side === 'new' && 'border-l border-border/40')} />
  }
  const { line } = cell
  return (
    <div
      data-slot="diff-cell"
      data-line={line.kind}
      className={cn('flex min-w-0 overflow-x-auto', LINE_BG[line.kind], side === 'new' && 'border-l border-border/40')}
    >
      <Gutter value={side === 'old' ? line.oldLine : line.newLine} />
      <span className="w-4 shrink-0 text-soft-foreground select-none">{MARKER[line.kind]}</span>
      <LineContent cell={cell} tokens={tokensFor(line)} wrap={wrap} />
    </div>
  )
}

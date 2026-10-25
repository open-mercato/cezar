import { useEffect, useImperativeHandle, useRef, useState, type ComponentType } from 'react'

import type { DiffStat } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { cn } from '@/lib/utils'

import { ImagePreview, shouldPreviewImage } from './image-preview'
import { diffScroller, scrollWithin } from './scroll-within'
import type { DiffFileChange, DiffProps } from './types'

/**
 * `<Diff>` — the ONE diff surface of the cockpit (spec §"Session git view" #390; R5 1.4).
 * Props are ours (`./types.ts`); consumers never import a diff library.
 *
 * Engine decision (Step 1.4): `@pierre/diffs` v1.2.12 was evaluated and REJECTED — it
 * imports `createHighlighter` from the full `shiki` bundle entry and keeps its own
 * module-level highlighter singleton + theme pipeline (`@pierre/theming`), with no API to
 * feed it our `shiki/core` singleton or pre-tokenized lines. Adopting it would instantiate
 * Shiki twice and pull the full-bundle entry into `web/dist` — both explicitly forbidden by
 * `lib/highlighter.ts`'s contract — and its Shadow-DOM/own-theme styling bypasses our
 * `--diff-*`/`--syn-*` tokens (7.1 MB dist besides). So the facade renders on our own
 * `./diff-view` implementation. If an engine swap ever happens, it happens HERE, behind the
 * same props.
 *
 * The renderer loads as a lazy chunk (parser + word-diff + Shiki wiring stay off the main
 * bundle). If that chunk fails to load — stale deploy, partial `web/dist`, offline cache —
 * the inline `DiffFallback` below renders the same props as plain marked-up patch text:
 * degraded, never blank.
 */
type Engine = { View: ComponentType<DiffProps> } | 'failed'

/** The chunk resolves once per page; every later mount renders it synchronously instead of
 *  flashing "Loading diff…". A failure is not remembered, so the next mount retries. */
let loadedEngine: { View: ComponentType<DiffProps> } | null = null
let enginePromise: Promise<Engine> | null = null
function loadEngine(): Promise<Engine> {
  enginePromise ??= import('./diff-view').then(
    (module) => (loadedEngine = { View: module.DiffView }),
    () => {
      enginePromise = null
      return 'failed' as const
    },
  )
  return enginePromise
}

export function Diff(props: DiffProps) {
  const [engine, setEngine] = useState<Engine | null>(loadedEngine)
  useEffect(() => {
    if (loadedEngine) return
    let cancelled = false
    loadEngine().then((loaded) => {
      if (!cancelled) setEngine(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The empty state needs no engine — render it synchronously, chunk or no chunk.
  if (props.files.length === 0) {
    return (
      <p data-slot="diff-empty" className={cn('px-1 text-xs text-soft-foreground', props.className)}>
        No changes.
      </p>
    )
  }
  if (engine === 'failed') return <DiffFallback {...props} />
  if (engine === null) {
    return (
      <p data-slot="diff-loading" className={cn('px-1 text-xs text-soft-foreground', props.className)}>
        Loading diff…
      </p>
    )
  }
  return <engine.View {...props} />
}

/**
 * The zero-dependency fallback: same props, raw patch text with `+`/`-` line tints from the
 * theme tokens. No parser, no highlighter, no lazy import — nothing here can fail the way
 * the engine chunk can. Split mode degrades to unified and Markdown `preview` to the plain
 * patch; that is documented degradation, not a bug.
 */
export function DiffFallback({ files, wrap = false, imageSrc, oldImageSrc, onOpenInApp, viewRef, className }: DiffProps) {
  const stat: DiffStat = {
    adds: files.reduce((sum, file) => sum + file.adds, 0),
    dels: files.reduce((sum, file) => sum + file.dels, 0),
    files: files.length,
  }
  // The fallback never virtualizes, so every file IS in the DOM — the handle a consumer's
  // file tree calls resolves straight to the element. Without this the tree would silently
  // stop scrolling whenever the engine chunk failed to load. Matched on `dataset` rather than
  // an attribute selector, for the reasons `diff-view.tsx`'s `findFileElement` spells out
  // (this stays inline rather than importing that helper: it lives in the lazy engine chunk,
  // and the fallback exists precisely for when that chunk is unreachable).
  const root = useRef<HTMLDivElement | null>(null)
  useImperativeHandle(viewRef, () => ({
    scrollToPath: (path: string) => {
      for (const element of root.current?.querySelectorAll<HTMLElement>('[data-slot="diff-file"]') ?? []) {
        if (element.dataset.path === path) {
          const scroller = diffScroller(element)
          if (scroller) scrollWithin(scroller, element, Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0)
          return
        }
      }
    },
  }))
  return (
    <div ref={root} data-slot="diff" data-fallback="true" className={cn('flex min-w-0 flex-col gap-3', className)}>
      <p data-slot="diff-totals" className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>
          {stat.files} {stat.files === 1 ? 'file' : 'files'} changed
        </span>
        <DiffStatLabel stat={stat} />
      </p>
      {files.map((file) => (
        <FallbackFile
          key={`${file.oldPath ?? ''}→${file.path}`}
          file={file}
          wrap={wrap}
          imageSrc={imageSrc}
          onOpenInApp={onOpenInApp}
          oldImageSrc={oldImageSrc}
        />
      ))}
    </div>
  )
}

function FallbackFile({
  file,
  wrap,
  imageSrc,
  onOpenInApp,
  oldImageSrc,
}: {
  file: DiffFileChange
  wrap: boolean
  imageSrc?: (path: string) => string
  onOpenInApp?: (path: string) => void
  oldImageSrc?: (path: string) => string
}) {
  return (
    <section
      data-slot="diff-file"
      data-path={file.path}
      className="min-w-0 scroll-mt-[var(--diff-sticky-top,0px)] overflow-clip rounded-md border border-border bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <span data-slot="diff-file-path" className="min-w-0 truncate font-mono text-xs font-medium">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="ml-auto shrink-0">
          <DiffStatLabel stat={{ adds: file.adds, dels: file.dels, files: 1 }} className="text-[11px]" />
        </span>
      </header>
      {shouldPreviewImage(file) ? (
        <ImagePreview file={file} imageSrc={imageSrc} oldImageSrc={oldImageSrc} onOpenInApp={onOpenInApp} />
      ) : file.binary ? (
        <p className="px-4 py-2.5 text-xs text-soft-foreground">Binary file — no text diff.</p>
      ) : file.patch === '' ? (
        <p className="px-4 py-2.5 text-xs text-soft-foreground">No content changes (metadata only).</p>
      ) : (
        <pre
          className={cn(
            'py-2 font-mono text-xs leading-[1.7]',
            wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto whitespace-pre',
          )}
        >
          {file.patch.split('\n').map((line, index) => (
            <span
              key={index}
              className={cn(
                'block px-4',
                line.startsWith('+') && !line.startsWith('+++') && 'bg-diff-add',
                line.startsWith('-') && !line.startsWith('---') && 'bg-diff-del',
                line.startsWith('@@') && 'text-soft-foreground',
              )}
            >
              {line}
              {line === '' ? ' ' : ''}
            </span>
          ))}
        </pre>
      )}
    </section>
  )
}

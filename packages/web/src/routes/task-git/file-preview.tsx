import { FileQuestionIcon, FileWarningIcon, FileXIcon, MousePointerClickIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError, repoFileRawUrl, runFileRawUrl } from '@/api/client'
import { useRepoFile, useRunFile } from '@/api/queries'
import type { WorktreeEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { highlight, highlightSync, langForPath, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

import { Markdown } from '../task-thread/markdown'
import { formatFileSize, previewKind } from './worktree-files'

/**
 * The preview pane behind BOTH file browsers (R5 Step 1.6; generalized for the repo Files sub-tab,
 * #1279). Every state is honest about WHY there is no text: images render inline from the server's
 * raw mode (image extensions only — the server refuses everything else as bytes), size-capped files
 * say "too large", binary non-images say "binary", and a 409 comes back in the server's own words.
 * Text goes through the ONE Shiki singleton with `langForPath`, plaintext fallback included.
 *
 * `source` is what made this reusable: a run's worktree and the project checkout answer the same
 * `WorktreeEntry` shape from two different routes, so the only coupling was which hook to call.
 */
export type FileSource = { kind: 'run'; runId: string } | { kind: 'repo' }

/**
 * One entry, from whichever route `source` names.
 *
 * BOTH hooks are called every render — the inactive one with an `undefined` path, which disables
 * its query. Branching on `source` to call only one would be a conditional hook, and the cost of
 * the disabled one is a cache read.
 */
function useFileEntry(source: FileSource, path: string | undefined) {
  const run = useRunFile(
    source.kind === 'run' ? source.runId : undefined,
    source.kind === 'run' ? path : undefined,
  )
  const repo = useRepoFile(source.kind === 'repo' ? path : undefined)
  return source.kind === 'run' ? run : repo
}

/** The raw-bytes URL for an image, per source. */
function rawUrl(source: FileSource, path: string): string {
  return source.kind === 'run' ? runFileRawUrl(source.runId, path) : repoFileRawUrl(path)
}

export function FilePreview({
  source,
  path,
  className,
}: {
  source: FileSource
  path: string | null
  className?: string
}) {
  const entry = useFileEntry(source, path ?? undefined)

  if (path === null) {
    return (
      <Pane className={className}>
        <CenteredState
          icon={<MousePointerClickIcon />}
          tone="neutral"
          heading="h2"
          title="Select a file"
          subtitle="Pick a file from the tree to preview it here."
        />
      </Pane>
    )
  }
  if (entry.isPending) {
    return (
      <Pane className={className}>
        <p data-slot="file-preview-loading" className="px-4 py-6 text-center text-xs text-soft-foreground">
          Loading {path}…
        </p>
      </Pane>
    )
  }
  if (entry.isError) {
    // A 409 is the server's answer ("symlinks are not served: …", "path is not in the repository
    // index: …"), not an outage.
    const refused = entry.error instanceof ApiError && entry.error.status === 409
    return (
      <Pane className={className}>
        <CenteredState
          icon={refused ? <FileXIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'Cannot preview this file' : 'Could not load this file'}
          subtitle={entry.error.message}
        />
      </Pane>
    )
  }
  if (entry.data.type !== 'file') {
    // Directories are the tree's business; a stale selection that became a dir shows nothing.
    return null
  }
  return <FileEntryView source={source} entry={entry.data} className={className} />
}

/** True for the extensions the viewer offers a rendered Markdown view for. */
function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/**
 * The Markdown view mode, remembered for the SESSION rather than per file: someone reading several
 * specs in a row should not re-toggle at every one. Module-level on purpose — this is a transient
 * view preference, not state a user authors, so it earns no storage key (AGENTS.md § Zero config).
 */
let markdownViewMode: 'rendered' | 'source' = 'rendered'

function FileEntryView({
  source,
  entry,
  className,
}: {
  source: FileSource
  entry: Extract<WorktreeEntry, { type: 'file' }>
  className?: string
}) {
  const kind = previewKind(entry)
  const markdown = kind === 'text' && isMarkdownPath(entry.path)
  const [mode, setMode] = useState(markdownViewMode)
  const pick = (next: 'rendered' | 'source') => {
    markdownViewMode = next
    setMode(next)
  }

  return (
    <Pane className={className}>
      {/* Sticky like the diff's file headers, so a long file never loses its name: it pins to the
          top of the preview column while the lines scroll beneath it. Opaque for that reason (the
          old `bg-muted/40` let lines show through), with the same 1px cover above it as the diff
          header to close WebKit's sub-pixel seam at the column's top edge. */}
      <header
        data-slot="file-preview-head"
        className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-[color-mix(in_oklab,var(--muted)_40%,var(--card))] px-4 py-2 text-xs shadow-[0_-1px_0_color-mix(in_oklab,var(--muted)_40%,var(--card))]"
      >
        <span className="min-w-0 truncate font-mono font-medium">{entry.path}</span>
        {markdown ? (
          <div data-slot="markdown-view-toggle" className="ml-auto flex shrink-0 overflow-hidden rounded-sm border border-border">
            {(['rendered', 'source'] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-mode={value}
                aria-pressed={mode === value}
                onClick={() => pick(value)}
                className={cn(
                  'px-2 py-0.5 capitalize',
                  mode === value ? 'bg-muted font-medium text-foreground' : 'text-soft-foreground hover:bg-muted',
                )}
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}
        <span className={cn('shrink-0 tabular-nums text-soft-foreground', markdown ? 'pl-2' : 'ml-auto')}>
          {formatFileSize(entry.size)}
        </span>
      </header>
      {kind === 'image' ? (
        <div className="flex justify-center p-4">
          {/* Raw bytes from the same origin the JSON came from — no auth story to get wrong. */}
          <img
            data-slot="file-preview-image"
            src={rawUrl(source, entry.path)}
            alt={entry.path}
            className="max-h-[70vh] max-w-full rounded-sm"
          />
        </div>
      ) : kind === 'too-large' ? (
        <CenteredState
          icon={<FileWarningIcon />}
          tone="neutral"
          heading="h2"
          title="Too large to preview"
          subtitle={`${formatFileSize(entry.size)} — past the preview cap. Open it in your editor instead.`}
        />
      ) : kind === 'binary' ? (
        <CenteredState
          icon={<FileQuestionIcon />}
          tone="neutral"
          heading="h2"
          title="Binary file"
          subtitle={`${formatFileSize(entry.size)} of binary data — no text preview.`}
        />
      ) : markdown && mode === 'rendered' ? (
        // The thread's own Markdown component: the same single Shiki for fences and the same
        // link-safety policy, which a repository README needs for exactly the same reason agent
        // output does. A second Streamdown configuration here would be two renderers to keep honest.
        <div data-slot="file-preview-markdown" className="px-4 py-3">
          <Markdown>{entry.content ?? ''}</Markdown>
        </div>
      ) : (
        <CodeLines path={entry.path} text={entry.content ?? ''} />
      )}
    </Pane>
  )
}

/** The preview card — same bordered grammar as the diff facade's file cards. `overflow-clip`, not
 *  `overflow-hidden`: both round the corners, but `hidden` makes the card a scroll container of its
 *  own, which would pin the sticky header to a card that never scrolls instead of to the column. */
function Pane({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section data-slot="file-preview" className={cn('overflow-clip rounded-lg border border-border bg-card', className)}>
      {children}
    </section>
  )
}

/** Past this many lines highlighting is skipped — plaintext beats jank (diff-view.tsx's cap). */
const HIGHLIGHT_MAX_LINES = 1500

/** Tokens for the whole file through the shared singleton: sync when the grammar is resident,
 *  async load once when not, plaintext for unknown/oversized files. Same shape as the diff
 *  facade's useFileTokens — this one owns whole files instead of patch lines. */
function useFileTokens(path: string, text: string): SynToken[][] {
  const plain = useMemo(() => text.split('\n').map((line) => [{ content: line }]), [text])
  const lang = useMemo(() => langForPath(path), [path])
  const oversized = plain.length > HIGHLIGHT_MAX_LINES
  const [loaded, setLoaded] = useState<{ key: string; tokens: SynToken[][] } | null>(null)

  useEffect(() => {
    if (lang === null || oversized) return
    let cancelled = false
    void highlight(text, lang).then((result) => {
      if (!cancelled) setLoaded({ key: `${path}\0${text}`, tokens: result.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [path, text, lang, oversized])

  if (lang === null || oversized) return plain
  if (loaded?.key === `${path}\0${text}`) return loaded.tokens
  return highlightSync(text, lang)?.tokens ?? plain
}

function CodeLines({ path, text }: { path: string; text: string }) {
  const tokens = useFileTokens(path, text)
  return (
    <div
      data-slot="file-preview-code"
      data-lang={langForPath(path) ?? 'plaintext'}
      className="overflow-x-auto py-2 font-mono text-xs leading-[1.7]"
    >
      {tokens.map((line, index) => (
        <div key={index} className="flex px-4">
          <span className="w-10 shrink-0 select-none pr-3 text-right tabular-nums text-soft-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre pr-4">
            {line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                style={token.color !== undefined ? { color: token.color } : undefined}
              >
                {token.content}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

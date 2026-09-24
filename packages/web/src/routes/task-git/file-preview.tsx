import { FileQuestionIcon, FileWarningIcon, FileXIcon, MousePointerClickIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError, runFileRawUrl } from '@/api/client'
import { useRunFile } from '@/api/queries'
import type { WorktreeEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { highlight, highlightSync, langForPath, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

import { formatFileSize, previewKind } from './worktree-files'

/**
 * The Files tab's preview pane (R5 Step 1.6). Every state is honest about WHY there is no
 * text: images render inline from the server's raw mode (image extensions only — the server
 * refuses everything else as bytes), size-capped files say "too large", binary non-images
 * say "binary", and a 409 comes back in the server's own words. Text goes through the ONE
 * Shiki singleton with `langForPath`, plaintext fallback included.
 */
export function FilePreview({ runId, path, className }: { runId: string; path: string | null; className?: string }) {
  const entry = useRunFile(runId, path ?? undefined)

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
    // A 409 is the server's answer ("symlinks are not served: …"), not an outage.
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
  return <FileEntryView runId={runId} entry={entry.data} className={className} />
}

function FileEntryView({
  runId,
  entry,
  className,
}: {
  runId: string
  entry: Extract<WorktreeEntry, { type: 'file' }>
  className?: string
}) {
  const kind = previewKind(entry)
  return (
    <Pane className={className}>
      <header
        data-slot="file-preview-head"
        className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs"
      >
        <span className="min-w-0 truncate font-mono font-medium">{entry.path}</span>
        <span className="ml-auto shrink-0 tabular-nums text-soft-foreground">{formatFileSize(entry.size)}</span>
      </header>
      {kind === 'image' ? (
        <div className="flex justify-center p-4">
          {/* Raw bytes from the same origin the JSON came from — no auth story to get wrong. */}
          <img
            data-slot="file-preview-image"
            src={runFileRawUrl(runId, entry.path)}
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
      ) : (
        <CodeLines path={entry.path} text={entry.content ?? ''} />
      )}
    </Pane>
  )
}

/** The preview card — same bordered grammar as the diff facade's file cards. */
function Pane({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section data-slot="file-preview" className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
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

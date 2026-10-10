import {
  EllipsisIcon,
  FileQuestionIcon,
  FileWarningIcon,
  FileXIcon,
  MousePointerClickIcon,
  PencilIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { ApiError, runFileRawUrl } from '@/api/client'
import { queryKeys, useHealth, useRunFile, useSaveRunFile } from '@/api/queries'
import type { WorktreeEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { highlight, highlightSync, langForPath, type SynToken } from '@/lib/highlighter'
import { cn } from '@/lib/utils'

import type { FileAction } from './file-actions'
import { formatFileSize, previewKind } from './worktree-files'

/**
 * The Files tab's preview pane (R5 Step 1.6). Every state is honest about WHY there is no
 * text: images render inline from the server's raw mode (image extensions only — the server
 * refuses everything else as bytes), size-capped files say "too large", binary non-images
 * say "binary", and a 409 comes back in the server's own words. Text goes through the ONE
 * Shiki singleton with `langForPath`, plaintext fallback included.
 */
/** CodeMirror and its grammars are a chunk of their own, fetched the first time a file is edited —
 *  browsing files never pays for it. */
const CodeMirrorEditor = lazy(() => import('@/components/code-mirror-editor'))

/**
 * An edit in progress. `baseHash` / `baseContent` are pinned when editing STARTS (and moved only
 * by a successful save), never re-read from the cached entry: a background refetch would
 * otherwise hand the save a hash for content the user never saw, which is the exact overwrite
 * the server's stale-base guard exists to refuse.
 */
export interface FileEdit {
  path: string
  draft: string
  baseHash: string
  baseContent: string
}

export function isDirty(edit: FileEdit | null): boolean {
  return edit !== null && edit.draft !== edit.baseContent
}

export function FilePreview({
  runId,
  path,
  className,
  edit = null,
  onEdit,
  onAction,
}: {
  runId: string
  path: string | null
  className?: string
  /** The edit in progress, owned by the caller so it can guard navigation away from it. */
  edit?: FileEdit | null
  /** Absent means read-only: no Edit button, whatever the server allows. */
  onEdit?: (next: FileEdit | null) => void
  /** Rename / delete this file. Absent hides the menu — the caller decides whether the cockpit
   *  allows it and owns the dialog. */
  onAction?: (action: FileAction) => void
}) {
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
  return (
    <FileEntryView
      runId={runId}
      entry={entry.data}
      className={className}
      edit={edit?.path === entry.data.path ? edit : null}
      onEdit={onEdit}
      onAction={onAction}
    />
  )
}

function FileEntryView({
  runId,
  entry,
  className,
  edit,
  onEdit,
  onAction,
}: {
  runId: string
  entry: Extract<WorktreeEntry, { type: 'file' }>
  className?: string
  edit: FileEdit | null
  onEdit?: (next: FileEdit | null) => void
  onAction?: (action: FileAction) => void
}) {
  const kind = previewKind(entry)
  const queryClient = useQueryClient()
  const save = useSaveRunFile(runId)
  // Two answers, both the server's: `fileEdit` is whether this cockpit allows editing at all,
  // `editable` whether this file can be saved back. The PUT refuses on either regardless.
  const allowed = useHealth().data?.capabilities?.fileEdit === true && onEdit !== undefined && kind === 'text'
  const dirty = isDirty(edit)
  const [wrap, setWrap] = useState(false)
  const [findRequest, setFindRequest] = useState(0)
  // The file moved on disk under an open editor — seen by any refetch, window focus included.
  const diverged = edit !== null && entry.hash !== undefined && entry.hash !== edit.baseHash

  const startEdit = () => {
    if (entry.hash === undefined) return
    const content = entry.content ?? ''
    onEdit?.({ path: entry.path, draft: content, baseHash: entry.hash, baseContent: content })
  }
  const submit = () => {
    if (edit === null || !dirty || save.isPending) return
    const draft = edit.draft
    save.mutate(
      { path: edit.path, content: draft, baseHash: edit.baseHash },
      { onSuccess: (saved) => onEdit?.({ ...edit, baseHash: saved.hash, baseContent: draft }) },
    )
  }
  const close = () => {
    save.reset()
    onEdit?.(null)
  }
  // Discard mine and show what is on disk now.
  const reload = () => {
    close()
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.file(runId, entry.path) })
  }

  return (
    <Pane className={className}>
      <header
        data-slot="file-preview-head"
        className="flex min-h-10 items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-xs"
      >
        <span className="min-w-0 truncate font-mono font-medium">{entry.path}</span>
        {dirty ? (
          <span data-slot="file-edit-dirty" className="shrink-0 text-soft-foreground">
            · unsaved
          </span>
        ) : null}
        <span className="ml-auto shrink-0 tabular-nums text-soft-foreground">{formatFileSize(entry.size)}</span>
        {!allowed ? null : edit !== null ? (
          <>
            <Button variant="ghost" size="xs" onClick={() => setFindRequest(findRequest + 1)}>
              Find
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={wrap}
              className={cn(wrap && 'bg-muted text-foreground')}
              onClick={() => setWrap(!wrap)}
            >
              Wrap
            </Button>
            <Button variant="ghost" size="xs" onClick={close} disabled={save.isPending}>
              {dirty ? 'Cancel' : 'Close'}
            </Button>
            <Button variant="contrast" size="xs" onClick={submit} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        ) : entry.editable ? (
          <Button variant="outline" size="xs" onClick={startEdit}>
            <PencilIcon />
            Edit
          </Button>
        ) : (
          <span data-slot="file-edit-readonly" className="shrink-0 text-soft-foreground" title={entry.editableReason}>
            Read-only
          </span>
        )}
        {/* Not while editing: renaming or deleting the file under an open draft is a second way to
            lose it, and Cancel is one click away. Any kind of file — an image can be renamed too. */}
        {onAction && edit === null ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="File actions">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onAction({ kind: 'rename', path: entry.path })}>Rename or move…</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onAction({ kind: 'delete', path: entry.path })}>
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      {edit !== null && (save.isError || diverged) ? (
        // Never auto-resolved and never destructive: the typed text stays in the editor until
        // the user picks. A refusal arrives in the server's own words.
        <div
          role="alert"
          data-slot="file-edit-conflict"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-danger/10 px-4 py-2 text-xs"
        >
          <TriangleAlertIcon className="size-3.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1">
            {save.isError
              ? save.error.message
              : 'This file changed on disk while you were editing — a save would be refused.'}
          </span>
          <Button variant="ghost" size="xs" onClick={() => void navigator.clipboard?.writeText(edit.draft)}>
            Copy my version
          </Button>
          <Button variant="outline" size="xs" onClick={reload}>
            Reload from disk
          </Button>
        </div>
      ) : null}
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
      ) : edit !== null ? (
        <div
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              submit()
            }
          }}
        >
          <Suspense
            fallback={
              <p data-slot="file-edit-loading" className="px-4 py-6 text-center text-xs text-soft-foreground">
                Loading the editor…
              </p>
            }
          >
            <CodeMirrorEditor
              // One editor per file: its line separator and undo history belong to that file.
              key={entry.path}
              value={edit.draft}
              onChange={(draft) => onEdit?.({ ...edit, draft })}
              // Held still while a save is in flight: its answer rebases the edit on the text
              // that was sent, and anything typed meanwhile would be rebased away.
              readOnly={save.isPending}
              path={entry.path}
              wrap={wrap}
              findRequest={findRequest}
              aria-label={`${entry.path} contents`}
              className="h-[70vh]"
            />
          </Suspense>
        </div>
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

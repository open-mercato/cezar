import { useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { queryKeys, useRunDiff } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { highlight, highlightSync, type SynToken } from '@/lib/highlighter'
import { diffTotals, parseUnifiedDiff, type DiffFile } from '@/lib/unified-diff'
import { cn } from '@/lib/utils'

/**
 * A run's worktree diff (`GET /api/runs/:id/diff`) as collapsible per-file sections — shared by
 * the review gate (R3 2.2) and the variants compare view (R3 2.3), extracted from review-panel
 * so "the same diff rendering" is one component rather than a convention.
 *
 * Rendering is the honest R3 interim: unified text parsed by `parseUnifiedDiff`, lines
 * highlighted through the ONE Shiki singleton (`diff` grammar) with add/del backgrounds from
 * the `--diff-*` tokens. R5's Changes tab (word-level/split view, @pierre/diffs) replaces
 * `DiffFileBody` — that component is the named boundary, exactly like `InlineDiffPreview`.
 */

/** Sections beyond this many start hidden behind "Show N more files". */
const FILE_CAP = 20
/** Per-file line cap — a generated lockfile must not wedge the page. */
const DIFF_CLAMP_LINES = 300

export function RunDiff({ runId }: { runId: string }) {
  const queryClient = useQueryClient()
  const diff = useRunDiff(runId)
  // Legacy parity (web/app.js: the review panel "(re)loads the diff on each entry"): both
  // consumers mount this exactly when the reader enters the surface — marking the cached diff
  // stale here refetches it on every re-entry, never showing a pre-send-back diff after the
  // agent worked again.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.diff(runId) })
  }, [queryClient, runId])

  const files = useMemo(() => parseUnifiedDiff(diff.data ?? ''), [diff.data])
  const [showAllFiles, setShowAllFiles] = useState(false)

  if (diff.isPending) {
    return <p className="px-1 text-xs text-soft-foreground">Loading diff…</p>
  }
  if (diff.isError) {
    return <p className="px-1 text-xs text-danger">{diff.error.message}</p>
  }
  if (files.length === 0) {
    // Not a diff: the server's own sentence ("(no worktree — …)", "(diff failed …)") or an
    // empty answer. Show its words — they were written for the reader.
    return (
      <p data-slot="run-diff-empty" className="px-1 font-mono text-xs text-soft-foreground">
        {diff.data.trim() || '(no changes)'}
      </p>
    )
  }

  const totals = diffTotals(files)
  const shown = showAllFiles ? files : files.slice(0, FILE_CAP)
  return (
    <div data-slot="run-diff" className="flex min-w-0 flex-col gap-2">
      <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>
          {totals.files} {totals.files === 1 ? 'file' : 'files'} changed
        </span>
        <span className="font-mono font-semibold tabular-nums">
          <span className="text-success">+{totals.additions}</span>{' '}
          <span className="text-danger">−{totals.deletions}</span>
        </span>
      </p>
      {shown.map((file) => (
        <DiffFileSection key={`${file.oldPath ?? ''}→${file.path}`} file={file} />
      ))}
      {files.length > shown.length ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAllFiles(true)}>
          Show {files.length - shown.length} more files
        </Button>
      ) : null}
    </div>
  )
}

const statusBadge: Partial<Record<DiffFile['status'], string>> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
}

/** One file of the diff as a collapsible card: path (with rename lineage), ± counts, body. */
function DiffFileSection({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true)
  const badge = statusBadge[file.status]
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="diff-file"
      className="min-w-0 overflow-hidden rounded-md border border-border bg-card"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
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
        {file.binary ? (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            binary
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[11px] font-semibold tabular-nums">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/50">
          {file.binary ? (
            <p className="px-4 py-2.5 text-xs text-soft-foreground">Binary file — no text diff.</p>
          ) : file.lines.length === 0 ? (
            <p className="px-4 py-2.5 text-xs text-soft-foreground">No content changes (metadata only).</p>
          ) : (
            <DiffFileBody lines={file.lines} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * NAMED BOUNDARY for R5 (like `InlineDiffPreview`): @pierre/diffs' word-level `<Diff>`
 * replaces this body without touching the section chrome. Until then: the hunk lines through
 * the Shiki singleton's `diff` grammar, backgrounds from the `--diff-*` tokens, clamped with
 * an explicit "Show all" for huge files.
 */
function DiffFileBody({ lines }: { lines: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? lines : lines.slice(0, DIFF_CLAMP_LINES)
  const text = shown.join('\n')

  // Sync when the grammar is already resident (every file after the first), async once.
  const [loaded, setLoaded] = useState<{ text: string; tokens: SynToken[][] } | null>(null)
  useEffect(() => {
    let cancelled = false
    void highlight(text, 'diff').then((result) => {
      if (!cancelled) setLoaded({ text, tokens: result.tokens })
    })
    return () => {
      cancelled = true
    }
  }, [text])
  const tokens = loaded?.text === text ? loaded.tokens : (highlightSync(text, 'diff')?.tokens ?? null)

  return (
    <>
      <pre
        data-slot="diff-file-body"
        className="overflow-x-auto py-2 font-mono text-xs leading-[1.7] whitespace-pre"
      >
        {shown.map((line, index) => (
          <span
            key={index}
            className={cn(
              'block px-4',
              line.startsWith('+') && 'bg-diff-add',
              line.startsWith('-') && 'bg-diff-del',
              line.startsWith('@@') && 'text-soft-foreground',
            )}
          >
            {tokens?.[index] !== undefined
              ? tokens[index].map((token, i) => (
                  <span key={i} style={token.color !== undefined ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))
              : line}
            {/* An empty context line must still occupy its row. */}
            {line === '' ? ' ' : ''}
          </span>
        ))}
      </pre>
      {lines.length > DIFF_CLAMP_LINES ? (
        <button
          type="button"
          data-slot="diff-file-toggle"
          onClick={() => setExpanded((value) => !value)}
          className="block w-full border-t border-border/50 px-4 py-1.5 text-left text-[11px] font-medium text-soft-foreground hover:text-foreground"
        >
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </>
  )
}

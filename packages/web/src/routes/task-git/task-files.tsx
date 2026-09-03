import { FolderTreeIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useRun, useRunFile } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'

import { RunHeader } from '../task-thread/run-header'
import { FilePreview } from './file-preview'
import { FilesTree } from './files-tree'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'

/**
 * `/tasks/:id/files` — the session git view's read-only worktree browser (spec §"Session git
 * view — Changes & Files tabs (#390)", R5 Step 1.6): the run header with the Files tab
 * active, the lazily-loaded directory tree over `GET /api/runs/:id/files?path=`, and the
 * preview pane (Shiki text, inline images, honest too-large/binary states).
 *
 * Layout follows the Changes tab's conventions: tree left, pane right on md-and-up; below
 * `md` the columns stack (tree first) — unlike Changes, the tree cannot be hidden on phones
 * because it is the only way to pick a file.
 */
export function TaskFilesRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="files" />
  if (run.isError) return <GitTabLoadError tab="files" error={run.error} />
  return <FilesView run={run.data} />
}

function FilesView({ run }: { run: ApiRun }) {
  // The root listing doubles as the "is there a worktree at all?" probe — a 409 here is the
  // server's answer for the whole view, same stance as the Changes tab's /changes 409.
  const root = useRunFile(run.id, '')
  const [selected, setSelected] = useState<string | null>(null)

  const refused = root.isError && root.error instanceof ApiError && root.error.status === 409

  return (
    <div data-route="task-files" className="flex min-h-full flex-col">
      <RunHeader run={run} tab="files" />

      {root.isPending ? (
        <p data-slot="files-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading files…
        </p>
      ) : root.isError ? (
        <CenteredState
          icon={refused ? <FolderTreeIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'No files to browse' : 'Could not load the files'}
          subtitle={root.error.message}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-stretch gap-5 px-4 py-4 [--diff-sticky-top:7rem] md:flex-row md:items-start md:px-6">
          {/* Sticky beside a long preview on desktop, with its own scroller so a deep tree scrolls
              without dragging the preview along; first in the stack (and no scroller of its own) on
              phones, where the page IS the pane. The cap reads the same var the pin is set from, so
              the two cannot drift when this tab's chrome height changes. */}
          <aside
            data-slot="files-tree-pane"
            className="w-full shrink-0 md:sticky md:top-[var(--diff-sticky-top)] md:max-h-[calc(100dvh_-_var(--diff-sticky-top)_-_1rem)] md:w-60 md:overflow-y-auto md:overscroll-contain lg:w-72"
          >
            <FilesTree runId={run.id} selected={selected} onSelect={setSelected} />
          </aside>
          <FilePreview runId={run.id} path={selected} className="min-w-0 flex-1" />
        </div>
      )}
    </div>
  )
}

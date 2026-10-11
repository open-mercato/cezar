import { FolderTreeIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useRun, useRunFile } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { useIsDesktop } from '@/lib/use-desktop'

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
  // Keyed on the run for the same reason as the Changes tab: its columns scroll on their own,
  // outside the shell's per-pathname reset of `main`.
  return <FilesView key={run.data.id} run={run.data} />
}

function FilesView({ run }: { run: ApiRun }) {
  // The root listing doubles as the "is there a worktree at all?" probe — a 409 here is the
  // server's answer for the whole view, same stance as the Changes tab's /changes 409.
  const root = useRunFile(run.id, '')
  const [selected, setSelected] = useState<string | null>(null)
  const desktop = useIsDesktop()

  const refused = root.isError && root.error instanceof ApiError && root.error.status === 409

  return (
    <div data-route="task-files" className="flex min-h-full flex-col md:h-full">
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
        <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 md:flex-row md:px-6 md:py-0">
          {/* From md up a split, in CSS alone (as on the Changes tab): the route fills `main`, and the
              tree and the preview are two scrollers of their own under the header, so neither the
              header's height nor a long preview can hide the tree's rows. On phones the columns
              stack and the page IS the pane, so neither has a scroller of its own. */}
          <aside
            data-slot="files-tree-pane"
            className="w-full shrink-0 md:w-60 md:overflow-y-auto md:overscroll-contain md:py-4 lg:w-72"
          >
            <FilesTree runId={run.id} selected={selected} onSelect={setSelected} />
          </aside>
          {/* From md up a focusable region, because it scrolls on its own and a text preview
              holds nothing else to focus: WebKit (the desktop app) never makes a scroller
              focusable by itself. Below md the page is the scroller, so no extra tab stop. Same
              pattern as the transcript viewport (`role="region"` + label + tab stop). */}
          <div
            data-slot="file-preview-pane"
            {...(desktop ? { role: 'region', 'aria-label': 'File preview', tabIndex: 0 } : {})}
            className="min-w-0 flex-1 md:overflow-y-auto md:overscroll-contain"
          >
            {/* Padding on this wrapper, not on the scroller: sticky offsets count from the
                scroller's padding edge, so padding there would park the stuck header 16px down. */}
            <div className="md:py-4">
              <FilePreview source={{ kind: 'run', runId: run.id }} path={selected} className="min-w-0" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

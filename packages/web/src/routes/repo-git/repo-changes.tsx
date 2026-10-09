import { FileDiffIcon, TriangleAlertIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { ApiError } from '@/api/client'
import { useRepoChanges } from '@/api/queries'
import { Diff, type DiffHandle, type DiffMode } from '@/components/diff'
import { PageBody, PageToolbar } from '@/components/page'
import { Spinner } from '@/components/ui/spinner'
import { useIsDesktop } from '@/lib/use-desktop'

import { ChangesTree } from '../task-git/changes-tree'
import { DiffViewToggles } from '../task-git/diff-controls'
import { buildFileTree } from '../task-git/file-tree'
import { AnimatedDiffStat } from '../task-git/git-toolbar'
import { RepoEmpty } from './repo-empty'

/**
 * The repo view's Changes segment (R5 Step 1.7): the MAIN working tree's uncommitted diff
 * over `GET /api/repo/changes`, rendered by the exact components the task Changes tab uses —
 * `buildFileTree` + `ChangesTree` + the `<Diff>` facade — with the same unified/split + wrap
 * toggles. No git action bar here: committing on the main tree is the CLI's business; the
 * cockpit's commit/push flows belong to task worktrees (task-changes.tsx).
 *
 * Below `md` the same rule as the task tab applies: unified+wrap forced, tree hidden — the
 * per-file sticky headers carry the names.
 */
export function RepoChangesSection() {
  const changes = useRepoChanges()
  const desktop = useIsDesktop()

  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const diffRef = useRef<DiffHandle | null>(null)

  // A 409 is the server's answer ("not a git repository"), not an outage.
  const refused = changes.isError && changes.error instanceof ApiError && changes.error.status === 409

  const files = changes.data?.files ?? []
  const tree = useMemo(() => buildFileTree(files), [files])

  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  // Through the facade's handle, not the DOM — see the task Changes tab's note.
  const selectFile = (path: string) => {
    setSelected(path)
    diffRef.current?.scrollToPath(path)
  }

  return (
    <section data-slot="repo-changes" className="flex min-h-0 flex-1 flex-col">
      <PageToolbar data-slot="repo-changes-toolbar" className="gap-x-3">
        <span className="text-[13px] font-medium text-foreground">Uncommitted changes</span>
        {changes.data ? <AnimatedDiffStat stat={changes.data.stat} /> : null}
        {/* Same rule as the task toolbar: toggles exist ≥md only — phones force unified+wrap. */}
        <span className="ml-auto hidden items-center gap-1 md:flex">
          <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
        </span>
      </PageToolbar>

      {changes.isPending ? (
        <PageBody data-slot="changes-loading" className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Spinner />
          Loading changes…
        </PageBody>
      ) : changes.isError ? (
        <RepoEmpty
          icon={refused ? <FileDiffIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          title={refused ? 'No changes to show' : 'Could not load the changes'}
          description={changes.error.message}
        />
      ) : files.length === 0 ? (
        <RepoEmpty
          icon={<FileDiffIcon />}
          title="Working tree clean"
          description="No uncommitted changes in the main working tree. Edits show up here as they happen."
        />
      ) : (
        <PageBody className="flex min-h-0 items-start gap-6 [--diff-sticky-top:0rem]">
          {/* Same deal as the task Changes tab: sticky AND its own scroller, so a long file list
              never has to drag the diff to the bottom to show its last row. */}
          <aside
            data-slot="changes-tree-pane"
            className="sticky top-4 hidden max-h-[calc(100dvh_-_6rem)] w-60 shrink-0 overflow-y-auto overscroll-contain md:block lg:w-72"
          >
            <ChangesTree root={tree} selected={selected} onSelect={selectFile} />
          </aside>
          <Diff files={files} viewRef={diffRef} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0 flex-1" />
        </PageBody>
      )}
    </section>
  )
}

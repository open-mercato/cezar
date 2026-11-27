import { FileDiffIcon, TriangleAlertIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { ApiError } from '@/api/client'
import { useRepo, useRepoChanges } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { canPreviewMarkdown, Diff, type DiffHandle, type DiffMode } from '@/components/diff'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

import { ChangesTree } from '../task-git/changes-tree'
import {
  baseParam,
  ChangesBaseSelect,
  TruncatedNote,
  useViewedFiles,
  ViewedCounter,
  viewedScope,
  type ChangesBase,
} from '../task-git/changes-review'
import { TreePaneResizeHandle, treePaneWidthProps, useTreePaneWidth } from '../task-git/tree-pane-resize'
import { DiffViewToggles } from '../task-git/diff-controls'
import { buildFileTree } from '../task-git/file-tree'
import { AnimatedDiffStat } from '../task-git/git-toolbar'

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
  // Default: the current branch against the project's base branch (#2248) — the same
  // committed + uncommitted view a PR shows. "Uncommitted only" is the old answer.
  const [base, setBase] = useState<ChangesBase>({ kind: 'merge-base', ref: '' })
  const sendBase = baseParam(base, null)
  const repo = useRepo()
  // An unfinished ref ("vs another ref…" with nothing typed) keeps showing the last answer.
  const changes = useRepoChanges(sendBase ?? 'merge-base')
  const desktop = useIsDesktop()

  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)
  const [preview, setPreview] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const diffRef = useRef<DiffHandle | null>(null)
  const treePaneRef = useRef<HTMLElement | null>(null)
  const [treeWidth, setTreeWidth] = useTreePaneWidth()
  const treeWidthProps = treePaneWidthProps(treeWidth)

  // A 409 is the server's answer ("not a git repository"), not an outage.
  const refused = changes.isError && changes.error instanceof ApiError && changes.error.status === 409

  const files = changes.data?.files ?? []
  const tree = useMemo(() => buildFileTree(files), [files])
  const hasMarkdown = useMemo(() => files.some(canPreviewMarkdown), [files])
  const viewed = useViewedFiles(
    viewedScope({ id: 'repo', branch: repo.data?.info?.branch, base: sendBase ?? 'merge-base' }),
    files,
  )

  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  // Through the facade's handle, not the DOM — see the task Changes tab's note.
  const selectFile = (path: string) => {
    setSelected(path)
    diffRef.current?.scrollToPath(path)
  }

  return (
    <section data-slot="repo-changes" className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="repo-changes-toolbar"
        className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-2 md:px-6"
      >
        <ChangesBaseSelect value={base} onChange={setBase} />
        {changes.data ? <AnimatedDiffStat stat={changes.data.stat} /> : null}
        <ViewedCounter state={viewed} />
        {/* Same rule as the task toolbar: toggles exist ≥md only — phones force unified+wrap. */}
        <span className="ml-auto hidden items-center gap-1 md:flex">
          <DiffViewToggles
            mode={mode}
            wrap={wrap}
            preview={preview}
            onModeChange={setMode}
            onWrapChange={setWrap}
            onPreviewChange={hasMarkdown ? setPreview : undefined}
          />
        </span>
      </div>

      <TruncatedNote show={Boolean(changes.data?.truncated)} />

      {changes.isPending ? (
        <p data-slot="changes-loading" className="px-4 py-6 text-center text-label text-soft-foreground md:px-6">
          Loading changes…
        </p>
      ) : changes.isError ? (
        <CenteredState
          icon={refused ? <FileDiffIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'No changes to show' : 'Could not load the changes'}
          subtitle={changes.error.message}
        />
      ) : files.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon />}
          tone="neutral"
          heading="h2"
          title={base.kind === 'worktree' ? 'Working tree clean' : 'No changes'}
          subtitle={
            base.kind === 'worktree'
              ? 'No uncommitted changes in the main working tree. Edits show up here as they happen.'
              : 'Nothing differs from the comparison base. Edits show up here as they happen.'
          }
        />
      ) : (
        // Below md the diff scrolls in `main` under the repo header, which (unlike the task tabs'
        // run header) stays sticky at every width — so its file headers must still park below
        // it there. From md up they stick to their own column's top, so no offset.
        <div className="flex min-h-0 flex-1 gap-5 px-4 py-4 max-md:[--diff-sticky-top:7rem] md:px-6 md:py-0">
          {/* Same split as the task Changes tab: from md up the tree and the diff are two
              independent scrollers under the header, laid out in CSS alone. */}
          <aside
            ref={treePaneRef}
            data-slot="changes-tree-pane"
            style={treeWidthProps.style}
            className={cn(
              'hidden w-60 max-w-[60%] shrink-0 overflow-y-auto overscroll-contain py-4 md:block lg:w-72',
              treeWidthProps.className,
            )}
          >
            <ChangesTree root={tree} selected={selected} onSelect={selectFile} viewed={viewed} />
          </aside>
          <TreePaneResizeHandle
            paneRef={treePaneRef}
            width={treeWidth}
            onWidthChange={setTreeWidth}
            className="hidden md:block"
          />
          <div
            data-slot="diff-pane"
            data-diff-scroller={desktop ? '' : undefined}
            className="min-w-0 flex-1 md:overflow-y-auto md:overscroll-contain"
          >
            <Diff
              files={files}
              viewRef={diffRef}
              mode={effectiveMode}
              wrap={effectiveWrap}
              preview={desktop && hasMarkdown && preview}
              className="min-w-0 md:py-4"
            />
          </div>
        </div>
      )}
    </section>
  )
}

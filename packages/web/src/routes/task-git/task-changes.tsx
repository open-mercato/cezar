import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileDiffIcon, GitCommitHorizontalIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError, createRunPr, getRunFile, openRunFileInApp, openRunInCli, pushRun, runFileRawUrl } from '@/api/client'
import { queryKeys, useHealth, useRepo, useRun, useRunChanges } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffHandle, type DiffMode } from '@/components/diff'
import { toast } from '@/components/ui/toaster'
import { gitActionPolicy, type GitActionId } from '@/lib/git-actions'
import { useIsDesktop } from '@/lib/use-desktop'

import { isRunActive, lastSessionId } from '../task-thread/run-actions'
import { RunHeader } from '../task-thread/run-header'
import { ChangesTree } from './changes-tree'
import { CommitDialog } from './commit-dialog'
import { buildFileTree } from './file-tree'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'
import { GitToolbar } from './git-toolbar'

/**
 * `/tasks/:id/changes` — the session git view's Changes tab (spec §"Session git view —
 * Changes & Files tabs (#390)", R5 Step 1.5): the run header with the Changes tab active,
 * the git action toolbar (rendered VERBATIM from `gitActionPolicy` — the rules live there),
 * the collapsible file tree, and the `<Diff>` facade over `GET /api/runs/:id/changes`.
 *
 * Below `md` the view forces unified+wrap (spec: "unified+wrap forced <md") and hides the
 * tree — the per-file sticky headers carry the file names, and a 360px phone has no honest
 * room for a second column.
 */
export function TaskChangesRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="changes" />
  if (run.isError) return <GitTabLoadError tab="changes" error={run.error} />
  return <ChangesView run={run.data} />
}

function ChangesView({ run }: { run: ApiRun }) {
  const health = useHealth()
  // The remote that decides whether Push is offered comes from the PROJECT-scoped `/repo`, not
  // from `/api/health.repo`: health is bound to the boot folder, so a cezar booted outside a git
  // repo reported no remote for every project (#791).
  const repo = useRepo()
  // Poll while the run is active so writes appear as the agent makes them.
  const changes = useRunChanges(run.id, isRunActive(run.status))
  const desktop = useIsDesktop()

  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)
  const diffRef = useRef<DiffHandle | null>(null)

  const queryClient = useQueryClient()
  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  const push = useMutation({
    mutationFn: () => pushRun(run.id),
    onSuccess: (result) =>
      toast(
        result.upstreamSet
          ? `Pushed ${result.branch} to ${result.remote} (upstream set)`
          : `Pushed ${result.branch} to ${result.remote}`,
      ),
    onError,
  })
  const createPr = useMutation({
    mutationFn: () => createRunPr(run.id),
    onSuccess: (result) => {
      toast(`Draft PR created — ${result.url}`)
      void invalidateRuns() // the record now carries pullRequestUrl → the policy flips to View PR
    },
    onError,
  })
  const terminal = useMutation({
    mutationFn: () => openRunInCli(run.id),
    onError: (error: Error) => {
      // Same 409 fallback as the header's Terminal: no emulator → the command goes to the
      // clipboard so the user stays one paste away.
      if (error instanceof ApiError && error.command) {
        void navigator.clipboard
          .writeText(error.command)
          .then(() => toast('No terminal found — command copied to clipboard.'))
          .catch(() => toast(`Run manually: ${error.command}`))
        return
      }
      onError(error)
    },
  })
  // Diff pane "open in default app" (#365, local mode only) — the mutation itself is safe to
  // wire unconditionally; only its trigger (the `onOpenInApp` prop below) is capability-gated.
  const openImage = useMutation({
    mutationFn: (path: string) => openRunFileInApp(run.id, path),
    onError,
  })

  // A 409 from /changes is an answer, not an outage: "no worktree — …" (or a git failure).
  const changesRefused = changes.isError && changes.error instanceof ApiError && changes.error.status === 409

  const bar = gitActionPolicy({
    status: run.status,
    hasWorktree: Boolean(run.worktreePath) && !changesRefused,
    branch: run.branch,
    changedFiles: changes.data?.stat.files,
    remote: repo.data?.info?.remote,
    forge: health.data?.forge ?? null,
    localHandoff: health.data?.capabilities.localHandoff ?? false,
    hasSession: lastSessionId(run) !== undefined,
    prUrl: run.pullRequestUrl,
  })

  const onAction = (id: GitActionId) => {
    switch (id) {
      case 'commit':
        setCommitOpen(true)
        break
      case 'push':
        push.mutate()
        break
      case 'create-pr':
        createPr.mutate()
        break
      case 'open-terminal':
        terminal.mutate()
        break
      case 'view-pr':
        break // the toolbar renders it as an <a> (safe href) or disabled (unsafe) — never routed here
    }
  }

  const files = changes.data?.files ?? []
  const tree = useMemo(() => buildFileTree(files), [files])

  // Phones force the readable combination; the toggles only exist ≥md (toolbar hides them).
  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  // Through the facade's handle, not the DOM: past `diff-scroll.ts`'s threshold the diff is
  // virtualized and the picked file may not be mounted to scroll to.
  const selectFile = (path: string) => {
    setSelected(path)
    diffRef.current?.scrollToPath(path)
  }

  return (
    <div data-route="task-changes" className="flex min-h-full flex-col">
      <RunHeader run={run} tab="changes" />

      <GitToolbar
        bar={bar}
        branch={run.branch}
        stat={changes.data?.stat}
        mode={effectiveMode}
        wrap={effectiveWrap}
        onModeChange={setMode}
        onWrapChange={setWrap}
        onAction={onAction}
      />

      {changes.data?.repointedHead ? (
        <p data-slot="repointed-head-note" className="border-b px-4 py-2 text-xs text-soft-foreground md:px-6">
          HEAD is on <code>{changes.data.repointedHead.headBranch}</code>, not this task&apos;s branch{' '}
          <code>{changes.data.repointedHead.taskBranch}</code> — showing only what this task changed there.
        </p>
      ) : null}

      {changes.isPending ? (
        <p data-slot="changes-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading changes…
        </p>
      ) : changes.isError ? (
        <CenteredState
          icon={changesRefused ? <FileDiffIcon /> : <GitCommitHorizontalIcon />}
          tone={changesRefused ? 'neutral' : 'danger'}
          heading="h2"
          title={changesRefused ? 'No changes to show' : 'Could not load the changes'}
          subtitle={changes.error.message}
        />
      ) : files.length === 0 ? (
        <CenteredState
          icon={<FileDiffIcon />}
          tone="neutral"
          heading="h2"
          title="No changes yet"
          subtitle="The worktree matches its base branch. Changes appear here as the agent works."
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-start gap-5 px-4 py-4 [--diff-sticky-top:10rem] md:px-6">
          {/* The tree column: sticky under the header so long diffs scroll beside it, and its OWN
              scroller. Sticky alone is not enough — a tree taller than the viewport grows the page
              instead, so the only way to reach its last file was to drag the shared `main` scroller
              (and the diff with it) to the bottom. Capping the pane at the space left under the
              sticky chrome gives the list its own scrollbar; `overscroll-contain` keeps a wheel
              inside it from chaining into the diff once it bottoms out. */}
          <aside
            data-slot="changes-tree-pane"
            className="sticky top-40 hidden max-h-[calc(100dvh_-_var(--diff-sticky-top)_-_1rem)] w-60 shrink-0 overflow-y-auto overscroll-contain md:block lg:w-72"
          >
            <ChangesTree root={tree} selected={selected} onSelect={selectFile} />
          </aside>
          <Diff
            files={files}
            viewRef={diffRef}
            mode={effectiveMode}
            wrap={effectiveWrap}
            loadFileText={(path) => loadWorktreeText(run.id, path)}
            imageSrc={(path) => runFileRawUrl(run.id, path)}
            onOpenInApp={
              health.data?.capabilities.localHandoff ? (path) => openImage.mutate(path) : undefined
            }
            className="min-w-0 flex-1"
          />
        </div>
      )}

      <CommitDialog run={run} open={commitOpen} onOpenChange={setCommitOpen} />
    </div>
  )
}

/** The facade's expandable-context source: the file's current text from the worktree, or
 *  null wherever the server can't honestly serve it (dir, binary, too large, gone). */
async function loadWorktreeText(runId: string, path: string): Promise<string | null> {
  try {
    const entry = await getRunFile(runId, path)
    if (entry.type !== 'file' || entry.binary || entry.tooLarge) return null
    return entry.content ?? null
  } catch {
    return null
  }
}

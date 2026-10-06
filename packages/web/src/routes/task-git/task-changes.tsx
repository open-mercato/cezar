import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileDiffIcon, GitCommitHorizontalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { ApiError, createRunPr, getRunFile, openRunFileInApp, openRunInCli, pushRun, runFileRawUrl } from '@/api/client'
import { queryKeys, useHealth, useRepo, useRun, useRunChanges } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffHandle, type DiffMode, type DiffRevealTarget } from '@/components/diff'
import { toast } from '@/components/ui/toaster'
import { gitActionPolicy, type GitActionId } from '@/lib/git-actions'
import { useIsDesktop } from '@/lib/use-desktop'

import { useDiffComments } from '../task-thread/diff-comments'
import { useContinueAction } from '../task-thread/follow-up-engine'
import { revealFromSearch } from '../task-thread/review-comments-block'
import { TaskComposer, TaskDock } from '../task-thread/task-composer'
import { useDraft } from '../task-thread/thread-draft'
import { useKeyboardInsetVar } from '@/lib/keyboard-inset'
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
  // Line comments for the agent (self-review): drafted here, and sent from the SAME composer the
  // Session tab docks — floated here while there is something to send, so the review can be given
  // a message (or a skill) without leaving the diff. This route is the one host of both drafts.
  const diffComments = useDiffComments(run.id)
  const commentCount = diffComments.comments.length
  const composerDraft = useDraft(run.id, 'composer')
  // Shown once there are comments, kept while a typed message is unsent — so deleting the last
  // comment never whisks away a half-written reply — and kept while a send is in flight: the
  // composer clears optimistically, and a box that vanished mid-send could not show the outcome.
  const [sending, setSending] = useState(false)
  // The dock opens for COMMENTS. Once open, a typed message keeps it up after the last comment
  // goes; but a draft left on the Session tab, with no comment here, never pulls it up on its own.
  const [dockHeld, setDockHeld] = useState(false)
  if (commentCount > 0 && !dockHeld) setDockHeld(true)
  if (dockHeld && commentCount === 0 && !composerDraft.hasDraft && !sending) setDockHeld(false)
  const showDock = commentCount > 0 || sending || (dockHeld && composerDraft.hasDraft)
  // The dock floats OVER the diff and the file tree. It takes no room of its own (a negative top
  // margin cancels its height), so both columns get that height back as bottom padding instead —
  // their last lines can still be scrolled up above the box.
  const [dockHeight, setDockHeight] = useState(0)
  const dockRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      setDockHeight(0)
      return
    }
    setDockHeight(element.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setDockHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of diffComments.comments) counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1)
    return counts
  }, [diffComments.comments])

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
  const diffShown = !changes.isPending && !changes.isError && files.length > 0
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
  /** To one comment or line — the exact spot, not the top of its file — wherever the renderer can. */
  const revealOrScroll = useCallback((target: DiffRevealTarget) => {
    setSelected(target.path)
    const handle = diffRef.current
    if (handle?.reveal) handle.reveal(target)
    else handle?.scrollToPath(target.path)
  }, [])

  // Arrived from a link to a comment or a line (a chip on the Session tab, a review in the
  // transcript): reveal it once the diff has rendered. The renderer is a lazy chunk, so its handle
  // may appear a moment after the files do — keep checking briefly. Once per target.
  const [searchParams] = useSearchParams()
  const searchTarget = useMemo(() => revealFromSearch(searchParams), [searchParams])
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!searchTarget || !diffShown) return
    const key = searchParams.toString()
    if (revealed.current === key) return
    let tries = 0
    const timer = setInterval(() => {
      if (!diffRef.current && ++tries < 40) return
      clearInterval(timer)
      revealed.current = key
      revealOrScroll(searchTarget)
    }, 75)
    return () => clearInterval(timer)
  }, [diffShown, revealOrScroll, searchParams, searchTarget])

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
        // The run header scrolls away on mobile; only desktop reserves space for it.
        <div
          className="flex min-h-0 flex-1 items-start gap-5 px-4 py-4 [--diff-sticky-top:0px] md:[--diff-sticky-top:10rem] md:px-6"
          style={
            {
              '--changes-dock': `${showDock ? dockHeight : 0}px`,
              paddingBottom: showDock ? `calc(1rem + ${dockHeight}px)` : undefined,
            } as React.CSSProperties
          }
        >
          {/* The tree column: sticky under the header so long diffs scroll beside it, and its OWN
              scroller. Sticky alone is not enough — a tree taller than the viewport grows the page
              instead, so the only way to reach its last file was to drag the shared `main` scroller
              (and the diff with it) to the bottom. Capping the pane at the space left under the
              sticky chrome gives the list its own scrollbar; `overscroll-contain` keeps a wheel
              inside it from chaining into the diff once it bottoms out. */}
          <aside
            data-slot="changes-tree-pane"
            className="sticky top-40 hidden max-h-[calc(100dvh_-_var(--diff-sticky-top)_-_1rem)] w-60 pb-[var(--changes-dock,0px)] shrink-0 overflow-y-auto overscroll-contain md:block lg:w-72"
          >
            <ChangesTree root={tree} selected={selected} onSelect={selectFile} commentCounts={commentCounts} />
          </aside>
          <Diff
            // Keyed by run: the open comment editor and its unsent text are keyed by path + line
            // only, and walking to another task keeps this view mounted — without the key a
            // half-written note would reappear on the same path + line of the next task.
            key={run.id}
            files={files}
            viewRef={diffRef}
            mode={effectiveMode}
            wrap={effectiveWrap}
            loadFileText={(path) => loadWorktreeText(run.id, path)}
            imageSrc={(path) => runFileRawUrl(run.id, path)}
            onOpenInApp={
              health.data?.capabilities.localHandoff ? (path) => openImage.mutate(path) : undefined
            }
            comments={diffComments.comments}
            // Not until the stored comments have loaded — see `DiffComments.ready`.
            onAddComment={diffComments.ready ? diffComments.add : undefined}
            onEditComment={diffComments.update}
            onRemoveComment={diffComments.remove}
            // Reserve the dock's covered area on diff targets only. Scroll padding on `main`
            // also affects the dock textarea: Chromium scrolls the page on every keystroke
            // trying to bring its caret above the very dock it lives in.
            className="min-w-0 flex-1 [&_[data-slot=diff-comment-editor]]:scroll-mb-[var(--changes-dock,0px)] [&_[data-slot=diff-line-comment]]:scroll-mb-[var(--changes-dock,0px)] [&_[data-slot=diff-line]]:scroll-mb-[var(--changes-dock,0px)]"
          />
        </div>
      )}

      {showDock ? (
        // `mt-auto` so a short view still parks it at the bottom, exactly where the Session tab's is.
        // Only over the diff does it float (the negative margin): above a loading line or an empty
        // state there is nothing to see through, and pulling it up would overlap the toolbar.
        <TaskDock
          ref={dockRef}
          floating
          className="mt-auto"
          style={{ marginTop: diffShown && dockHeight ? -dockHeight : undefined }}
        >
          <DockedComposer
            run={run}
            draft={composerDraft}
            diffComments={diffComments}
            onSendingChange={setSending}
            onOpenComment={(comment) =>
              revealOrScroll({ path: comment.path, side: comment.side, line: comment.line, commentId: comment.id })
            }
            getMentionCandidates={() => files.map((file) => file.path)}
          />
        </TaskDock>
      ) : null}

      <CommitDialog run={run} open={commitOpen} onOpenChange={setCommitOpen} />
    </div>
  )
}

/**
 * The composer as the Changes tab docks it. Its own component so that what only a VISIBLE
 * composer needs — the continue engine's queries (runner models, accounts, providers) and the
 * iOS keyboard tracking behind the dock's `bottom: var(--kb)` — runs only while the dock is shown,
 * not on every visit to the tab.
 */
function DockedComposer(props: Omit<ComponentProps<typeof TaskComposer>, 'continueAction'>) {
  const continueAction = useContinueAction(props.run)
  useKeyboardInsetVar()
  return <TaskComposer {...props} continueAction={continueAction} />
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

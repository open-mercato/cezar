import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { ApiError, createRunPr, pushRun } from '@/api/client'
import { queryKeys, useHealth, useRepo, useRunGitStatus } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useReferenceStatus } from '@/components/reference-status'
import { toast } from '@/components/ui/toaster'
import { gitActionPolicy, type GitAction, type GitActionId } from '@/lib/git-actions'
import { ownedTaskPr } from '@/lib/tasks-table'

import { useAskAnswer } from '../task-thread/ask-answer'
import { fixChecksPrompt, isRunActive, resolveConflictsPrompt, updateBranchPrompt } from '../task-thread/run-actions'
import { CommitDialog } from './commit-dialog'

/** The run's next git step: the policy's one action (or none), what pressing it does, and the
 *  dialog it may open. */
export interface RunGitStep {
  action: GitAction | null
  onAction: (id: GitActionId) => void
  dialogs: ReactNode
}

/**
 * The run's one git step, self-contained: it reads the worktree's cheap `git status` answer,
 * asks `gitActionPolicy` for the next step, and owns the mutations and the commit dialog behind
 * it. A hook rather than a button so the run header can paint the SAME step twice — the desktop
 * button and the phone menu's first item — from one state, one mutation and one commit dialog.
 * Must be called under a `ReferenceStatusProvider` that asks about the task's PRs (the run header
 * is one), so the merged/closed/conflict/CI answers are known.
 */
export function useRunGitStep(run: ApiRun): RunGitStep {
  // The PR this task OWNS — created or declared (`CEZ:PR`), never one scraped from its transcript
  // (see `ownedTaskPr`): a task working on an existing PR is never offered a second Create PR, and
  // a link the agent merely read never becomes the PR it is told to merge or fix.
  const owned = ownedTaskPr(run)
  const prUrl = owned?.url ?? (owned?.number !== undefined ? `#${owned.number}` : undefined)
  const prNumber = owned?.number
  // A merged (or closed) PR is the end of the road: nothing left to commit or push to it, and
  // its chip already links to it. The policy reads the forge's word directly.
  const prEntry = useReferenceStatus('PR', prNumber)
  const prStatus = prEntry.status
  const finished = prStatus === 'merged' || prStatus === 'closed'
  const health = useHealth()
  // The remote that decides whether Push is offered comes from the PROJECT-scoped `/repo`, not
  // from `/api/health.repo`: health is bound to the boot folder (#791).
  const repo = useRepo()
  const status = useRunGitStatus(run.id, Boolean(run.worktreePath) && !finished, isRunActive(run.status))
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitAndPush, setCommitAndPush] = useState(false)
  // Resolve conflicts / Fix errors are prompts to this task's own agent, through the same
  // seam as the PR chip's "Resolve conflicts": a live message, or a continue for a finished task.
  const agent = useAskAnswer(run)
  const [prompting, setPrompting] = useState(false)
  const promptAgent = async (prompt: string, doing: string) => {
    if (prompting || agent.isPending || agent.blockedBy) return
    // Read BEFORE the send: delivering flips a parked task to `running`.
    const reopened = agent.mode === 'resume'
    setPrompting(true)
    try {
      const failure = await agent.send(prompt)
      if (failure) toast(failure, { tone: 'danger' })
      else toast(`${reopened ? 'Task reopened' : 'Sent to the task'} — ${doing}${prNumber ? ` in PR #${prNumber}` : ''}`)
    } finally {
      setPrompting(false)
    }
  }

  const queryClient = useQueryClient()
  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  const push = useMutation({
    mutationFn: () => pushRun(run.id),
    onSuccess: (result) => {
      toast(
        result.upstreamSet
          ? `Pushed ${result.branch} to ${result.remote} (upstream set)`
          : `Pushed ${result.branch} to ${result.remote}`,
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.gitStatus(run.id) })
    },
    onError,
  })
  const createPr = useMutation({
    mutationFn: (draft: boolean) => createRunPr(run.id, { draft }),
    onSuccess: (result, draft) => {
      toast(`${draft ? 'Draft PR' : 'PR'} created — ${result.url}`)
      void invalidateRuns() // the record now carries pullRequestUrl → the policy moves past Create PR
    },
    onError,
  })

  // A 409 from `/git/status` is the server saying the worktree is gone — the same answer as the
  // Changes tab's 409, and every action greys out with that reason.
  const refused = status.isError && status.error instanceof ApiError && status.error.status === 409
  const action = gitActionPolicy({
    status: run.status,
    hasWorktree: !refused,
    branch: run.branch,
    uncommitted: status.data?.uncommitted,
    unpushed: status.data?.unpushed,
    behind: status.data?.behind,
    remote: repo.data?.info?.remote,
    forge: health.data?.forge ?? null,
    prUrl,
    prStatus,
    prConflicting: prEntry.conflicting,
    agentBlocked: agent.blockedBy ? (agent.reason ?? 'the agent cannot be reached') : undefined,
  })

  const onAction = (id: GitActionId) => {
    switch (id) {
      case 'commit':
        setCommitAndPush(false)
        setCommitOpen(true)
        break
      case 'commit-push':
        setCommitAndPush(true)
        setCommitOpen(true)
        break
      case 'push':
        push.mutate()
        break
      case 'create-pr':
        createPr.mutate(false)
        break
      case 'create-draft-pr':
        createPr.mutate(true)
        break
      case 'update-branch':
        void promptAgent(updateBranchPrompt(run.baseBranch), 'updating the branch')
        break
      case 'resolve-conflicts':
        void promptAgent(resolveConflictsPrompt(prNumber), 'resolving conflicts')
        break
      case 'fix-checks':
        void promptAgent(fixChecksPrompt(prNumber), 'fixing the errors')
        break
    }
  }

  return {
    action: run.worktreePath ? action : null,
    onAction,
    // Rendered by the host OUTSIDE any menu: a dialog mounted inside a dropdown's content would
    // close with the menu that opened it.
    dialogs: (
      <CommitDialog
        run={run}
        open={commitOpen}
        onOpenChange={setCommitOpen}
        andPush={commitAndPush}
        // The push follows the commit it publishes — only once that commit has landed.
        onCommitted={commitAndPush ? () => push.mutate() : undefined}
      />
    ),
  }
}

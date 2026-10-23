import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import { ApiError, adoptRunPr, createRunPr, landRun, pushRun } from '@/api/client'
import { queryKeys, useConfig, useHealth, useRepo, useRunGitStatus } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useReferenceStatus } from '@/components/reference-status'
import { toast } from '@/components/ui/toaster'
import { gitActionPolicy, trunkGitActionPolicy, type GitAction, type GitActionId } from '@/lib/git-actions'
import { ownedTaskPr } from '@/lib/tasks-table'

import { useAskAnswer } from '../task-thread/ask-answer'
import {
  commitPrompt,
  createPrPrompt,
  fixChecksPrompt,
  inPlacePrPrompt,
  inPlaceUpdatePrompt,
  isRunActive,
  pushPrompt,
  resolveConflictsPrompt,
  updateBranchPrompt,
} from '../task-thread/run-actions'
import { CommitDialog } from './commit-dialog'

/** The run's next git step: the policy's one action (or none), what pressing it does, and the
 *  dialog it may open. */
export interface RunGitStep {
  action: GitAction | null
  /** The step whose request (or, for an agent step, the turn it started) is still in flight. */
  pending: GitActionId | null
  /** The task's agent can take a git step right now; false means the server stands in for it. */
  byAgent: boolean
  onAction: (id: GitActionId) => void
  dialogs: ReactNode
  /** The commit dialog is up — the palette keeps its subject while it is. */
  commitOpen: boolean
}

/** How long a sent agent step waits to see its turn start before it stops spinning. */
const HANDOFF_GRACE_MS = 30_000
/** After the turn a step was queued behind ends: its own turn starts at once, or it was folded into
 *  the one that just ended. */
const QUEUED_TURN_GRACE_MS = 3_000

const isCreatePr = (id: GitActionId) => id === 'create-pr' || id === 'create-draft-pr'

/**
 * One in-flight git step per task, shared by every surface that offers it — the run header, the
 * review panel and the ⌘P palette each call `useRunGitStep`, and a step sent from one must block
 * the others (a second send repeats the agent's work) and be adopted once, not per surface.
 * `sending` covers the request; `handedOff` the agent's turn, until it is seen to start and end.
 */
interface Flight {
  id: GitActionId
  phase: 'sending' | 'handedOff'
  sawTurn: boolean
  sentAt: number
  /** Sent while a turn was already running: that turn is not this step's — wait it out first. */
  afterCurrentTurn: boolean
  /** How long to wait for the step's own turn to show before letting go. */
  graceMs: number
}
const flights = new Map<string, Flight>()
const flightListeners = new Set<() => void>()
const subscribeFlights = (listener: () => void) => {
  flightListeners.add(listener)
  return () => flightListeners.delete(listener)
}
function setFlight(runId: string, flight: Flight | null): void {
  if (flight) flights.set(runId, flight)
  else flights.delete(runId)
  for (const listener of flightListeners) listener()
}
/** Ends `flight` if it is still the current one — true for exactly one caller, so the work that
 *  follows (adoption) runs once however many surfaces saw the turn end. */
function endFlight(runId: string, flight: Flight): boolean {
  if (flights.get(runId) !== flight) return false
  setFlight(runId, null)
  return true
}
/** Tests only: no flight survives into the next case. */
export function __resetGitStepFlights(): void {
  flights.clear()
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
  const config = useConfig()
  // An in-place task in an auto-land project: its step is Commit to the base branch (spec
  // 2026-10-20-trunk-based-projects).
  const trunk =
    !run.worktreePath &&
    run.worktree === false &&
    !run.readOnly &&
    config.data?.landing === 'auto' &&
    config.data.landingBlocked === null
  const trunkBase = config.data?.baseBranch ?? repo.data?.info?.branch ?? 'main'
  // A trunk task reads the shared checkout, which other tasks land from too: keep it live.
  const status = useRunGitStatus(run.id, (Boolean(run.worktreePath) || trunk) && !finished, isRunActive(run.status) || trunk)
  const queryClientForStatus = useQueryClient()
  // A turn that just ended (or a landing that just settled) changed what there is to commit; the
  // last poll may predate it, and a stale "2 uncommitted" offers Commit on a clean tree.
  useEffect(() => {
    void queryClientForStatus.invalidateQueries({ queryKey: queryKeys.runs.gitStatus(run.id) })
  }, [run.status, run.id, queryClientForStatus])
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitAndPush, setCommitAndPush] = useState(false)
  // Every git step is a prompt to this task's own agent, through the same seam as the PR chip's
  // "Resolve conflicts": a live message, or a continue for a finished task.
  const agent = useAskAnswer(run, undefined, 'git_step')
  const queryClient = useQueryClient()
  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const flight = useSyncExternalStore(subscribeFlights, () => flights.get(run.id) ?? null)
  // An agent step stays busy after the send, until the TURN it started ends — otherwise the
  // button comes straight back and a second click sends the same prompt again. The turn, not the
  // session: an open session rests in `waiting`, which would hold the step busy indefinitely.
  const turnRunning = run.status === 'running' || run.status === 'queued'
  // Read at the moment a flight ends, not when the effect was created.
  const prUrlRef = useRef(prUrl)
  prUrlRef.current = prUrl
  // The agent opened the PR itself: record it by branch, even if it never declared CEZ:PR.
  const adoptIfCreatePr = (ended: Flight) => {
    if (isCreatePr(ended.id) && !prUrlRef.current) void adoptPr()
  }
  useEffect(() => {
    if (!flight || flight.phase !== 'handedOff') return
    if (flight.afterCurrentTurn) {
      // Still the turn that was running when the step was sent; its end starts the real wait.
      if (!turnRunning) {
        setFlight(run.id, { ...flight, afterCurrentTurn: false, sentAt: Date.now(), graceMs: QUEUED_TURN_GRACE_MS })
      }
      return
    }
    if (turnRunning) {
      if (!flight.sawTurn) setFlight(run.id, { ...flight, sawTurn: true })
      return
    }
    if (flight.sawTurn) {
      if (endFlight(run.id, flight)) adoptIfCreatePr(flight)
      return
    }
    // The record shows the new turn only once it refetches; never wait forever for it — and a
    // surface mounting long after the send must not inherit a stale spinner. A step folded into
    // the turn it was queued behind ends here too, so it still gets its adoption.
    const expire = () => {
      if (endFlight(run.id, flight)) adoptIfCreatePr(flight)
    }
    const left = flight.graceMs - (Date.now() - flight.sentAt)
    if (left <= 0) {
      expire()
      return
    }
    const timer = setTimeout(expire, left)
    return () => clearTimeout(timer)
  }, [turnRunning, flight])
  const adoptPr = async () => {
    try {
      const adopted = await adoptRunPr(run.id)
      if (adopted.found) void invalidateRuns() // the record now carries pullRequestUrl
    } catch {
      // Best-effort: the agent's own CEZ:PR declaration still records it.
    }
  }
  /** Send one git step to the agent, by its name (`Create PR`, …). */
  const promptAgent = async (id: GitActionId, buildPrompt: () => string) => {
    // Any step in flight — from any surface — blocks them all: mid-turn the button can turn into
    // the NEXT step (Commit and push → Push once the commit lands), and that click would repeat
    // the agent's own work.
    if (flights.has(run.id) || agent.blockedBy) return
    if (agent.isPending) {
      toast('Another message to the task is still being delivered — try again in a moment')
      return
    }
    const sending: Flight = {
      id,
      phase: 'sending',
      sawTurn: false,
      sentAt: Date.now(),
      afterCurrentTurn: turnRunning,
      graceMs: HANDOFF_GRACE_MS,
    }
    setFlight(run.id, sending)
    // No success toast: the busy button already says what is happening. Failures still toast.
    const failure = await agent.send(buildPrompt())
    if (flights.get(run.id) !== sending) return
    if (failure) {
      setFlight(run.id, null)
      toast(failure, { tone: 'danger' })
    } else {
      setFlight(run.id, { ...sending, phase: 'handedOff', sentAt: Date.now() })
    }
  }

  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  // The server-side fallback, for when no agent can be reached (see `gitActionPolicy`).
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
  // One request, whatever state the task is in; the answer says what happened.
  const land = useMutation({
    mutationFn: () => landRun(run.id),
    onSuccess: (answer) => {
      const text = answer.message.charAt(0).toUpperCase() + answer.message.slice(1)
      toast(text, answer.outcome === 'busy' || answer.outcome === 'unavailable' ? { tone: 'danger' } : undefined)
      void invalidateRuns()
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
  const agentBlocked = agent.blockedBy ? (agent.reason ?? 'the agent cannot be reached') : undefined
  const trunkAction = trunk
    ? trunkGitActionPolicy({
        status: run.status,
        base: trunkBase,
        uncommitted: status.data?.uncommitted,
        unpushed: status.data?.unpushed,
        behind: status.data?.behind,
        forge: health.data?.forge ?? null,
        agentBlocked,
        assessment: run.subject !== undefined,
      })
    : null
  const action = gitActionPolicy({
    status: run.status,
    hasWorktree: !refused,
    branch: run.branch,
    uncommitted: status.data?.uncommitted,
    unpushed: status.data?.unpushed,
    behind: status.data?.behind,
    ahead: status.data?.ahead,
    remote: repo.data?.info?.remote,
    forge: health.data?.forge ?? null,
    prUrl,
    prStatus,
    prConflicting: prEntry.conflicting,
    agentBlocked: agent.blockedBy ? (agent.reason ?? 'the agent cannot be reached') : undefined,
    assessment: run.subject !== undefined,
  })

  // The step in flight, if any: its button shows a spinner and refuses a second click.
  const pending: GitActionId | null =
    flight?.id ??
    (land.isPending ? 'land' : push.isPending ? 'push' : createPr.isPending ? (createPr.variables ? 'create-draft-pr' : 'create-pr') : null)

  const onAction = (id: GitActionId) => {
    // The agent runs every git step itself; the server only stands in when it cannot be reached.
    const viaServer = Boolean(agent.blockedBy)
    if (trunk) {
      if (id === 'land') {
        if (!land.isPending) land.mutate()
        return
      }
      if (id === 'create-pr' || id === 'create-draft-pr') {
        void promptAgent(id, () => inPlacePrPrompt(id === 'create-draft-pr', trunkBase))
        return
      }
      if (id === 'update-branch') {
        void promptAgent(id, () => inPlaceUpdatePrompt(trunkBase))
        return
      }
    }
    switch (id) {
      case 'land':
        break
      case 'commit':
      case 'commit-push':
        if (!viaServer) {
          const andPush = id === 'commit-push'
          void promptAgent(id, () => commitPrompt(andPush))
          break
        }
        setCommitAndPush(id === 'commit-push')
        setCommitOpen(true)
        break
      case 'push':
        if (!viaServer) void promptAgent(id, pushPrompt)
        else if (!push.isPending) push.mutate()
        break
      case 'create-pr':
      case 'create-draft-pr': {
        const draft = id === 'create-draft-pr'
        if (!viaServer) void promptAgent(id, () => createPrPrompt(draft, run.baseBranch))
        else if (!createPr.isPending) createPr.mutate(draft)
        break
      }
      case 'update-branch':
        void promptAgent(id, () => updateBranchPrompt(run.baseBranch))
        break
      case 'resolve-conflicts':
        void promptAgent(id, () => resolveConflictsPrompt(prNumber))
        break
      case 'fix-checks':
        void promptAgent(id, () => fixChecksPrompt(prNumber))
        break
    }
  }

  return {
    action: trunk ? trunkAction : run.worktreePath ? action : null,
    pending,
    byAgent: !agent.blockedBy,
    onAction,
    commitOpen,
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

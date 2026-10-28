import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError, archiveRun, cancelRun, deleteRun, getConfig, openRunIn, openRunInCli, startLifecycleRemoval } from '@/api/client'
import {
  queryKeys,
  useConfig,
  useHealth,
  useMarkRunSeen,
  useMarkRunUnseen,
  useOpenTargets,
  usePinRun,
  useProviderStatus,
} from '@/api/queries'
import type { OpenInChoice } from '@/components/open-in-menu'
import { lifecycleQueryKeys } from '@/api/worktree-lifecycle'
import type { ApiRun, TaskActionSurface } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { usableRunners } from '@/lib/provider-status'

import { cliTargetResumes, cliTargetRunner, runActionFlags } from './run-actions'
import type { RunConfirmKind } from './run-confirm-dialog'
import { useFinishRun } from './use-finish-run'
import { writeClipboard } from '@/lib/clipboard'

/** Terminal resume spawns a terminal on the SERVER's machine, so a hosted cockpit
 *  (`localHandoff: false`) never offers it — the route 409s there (telemetry f179cc7d). Only an
 *  explicit `false` hides it: the route stays authoritative while health is still loading. */
export function useCanOpenTerminal(run: ApiRun): boolean {
  const localHandoff = useHealth().data?.capabilities?.localHandoff
  return runActionFlags(run).terminal && localHandoff !== false
}

/** The mutations + confirm state, bundled so the desktop bar and the mobile kebab drive the
 *  exact same behavior. Every failure surfaces the server's own words as a danger toast. */
export function useRunActions(
  run: ApiRun,
  {
    onMarkedUnread,
    surface = 'task_view',
    onScreen = true,
  }: {
    onMarkedUnread?: () => void
    surface?: TaskActionSurface
    /** The run is the page's own. A deletion moves the page only then — the palette may delete a
     *  task picked from elsewhere. */
    onScreen?: boolean
  } = {},
) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState<RunConfirmKind | null>(null)
  const config = useConfig()
  const configured = config.data?.worktreeLifecycle
  const lifecycleDelete = !!run.worktreeLifecycle || (!!run.worktreePath && !!((configured?.afterCreate.length ?? 0) + (configured?.beforeRemove.length ?? 0)))

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const onError = (error: Error) => {
    // Every 409 here says the same thing: the record these buttons were drawn from is not the run
    // the server has (Continue on a run that is running again, Cancel on one that just finished).
    // Refetch it, so the bar redraws to the truth instead of offering the same refused action —
    // the composer's rule (deliver-prompt.ts) and the thread's healer (run-reconcile.ts), applied
    // to the actions. `useSendMessage` in queries.ts has always done exactly this.
    if (error instanceof ApiError && error.status === 409) void invalidate()
    toast(error.message, { tone: 'danger' })
  }

  // Shared with the review panel's ✓ Accept (use-finish-run.ts) — the review-accept semantics
  // must be ONE implementation, not two buttons that happen to agree today.
  const finish = useFinishRun(run.id)
  const archive = useMutation({
    mutationFn: (via?: TaskActionSurface) => archiveRun(run.id, !run.archived, via ?? surface),
    onSuccess: invalidate,
    onError,
  })
  // Pin/unpin (#935) — the shared hook rather than a local mutation, because the sidebar and the
  // Tasks table drive the same action and the cache rule belongs in one place. Toggling off the
  // record, exactly like archive above.
  const pinMutation = usePinRun(surface)
  const pin = {
    isPending: pinMutation.isPending,
    mutate: (via?: TaskActionSurface) => pinMutation.mutate({ id: run.id, pinned: !run.pinned, surface: via }, { onError }),
  }
  // Mark unread (#775) drives the shared optimistic hook rather than a local mutation: the
  // cache choreography (clear `seenAt`, guarded rollback) belongs next to its read twin in
  // queries.ts, and no `invalidate` is wanted here — an invalidation would refetch the list
  // and reinstate the receipt before the server's own answer lands.
  const markUnreadMutation = useMarkRunUnseen()
  const markUnread = {
    isPending: markUnreadMutation.isPending,
    mutate: () => {
      // Before the mutation, so the Session tab's suppression is in place by the time the
      // optimistic write re-renders the thread and re-evaluates its auto-mark-read effect.
      onMarkedUnread?.()
      markUnreadMutation.mutate(run.id, { onError })
    },
  }
  // Mark read — the twin of the above, through the same optimistic hook the thread's own
  // auto-read uses, so a click here and opening the task stamp the receipt identically.
  const markReadMutation = useMarkRunSeen()
  const markRead = {
    isPending: markReadMutation.isPending,
    mutate: () => markReadMutation.mutate(run.id, { onError }),
  }
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: invalidate, onError })
  const deleteMutation = useMutation({
    mutationFn: async () => {
      // The projection covers existing managed generations. A fresh config read also
      // protects a legacy worktree when scripts were configured after its creation.
      const current = run.worktreePath && !run.worktreeLifecycle ? await getConfig() : undefined
      const scripts = current?.worktreeLifecycle
      if (run.worktreeLifecycle || (run.worktreePath && ((scripts?.afterCreate.length ?? 0) + (scripts?.beforeRemove.length ?? 0) > 0))) {
        const response = await startLifecycleRemoval({requestId: crypto.randomUUID(), runId: run.id, intent: 'delete-task'})
        return {kind: 'lifecycle' as const, operation: response.operation}
      }
      await deleteRun(run.id)
      return {kind: 'deleted' as const}
    },
    onSuccess: result => {
      void invalidate()
      if (result.kind === 'lifecycle') {
        const operation = result.operation
        queryClient.setQueryData(lifecycleQueryKeys.operation(operation.id), {operation})
        queryClient.setQueryData<ApiRun>(queryKeys.runs.detail(run.id), previous => previous ? {...previous, worktreeLifecycle: {
          worktreeId: operation.worktreeId, generation: operation.generation, activeOperationId: operation.id,
          phase: operation.phase, state: operation.state, needsAttention: operation.state === 'needs_attention' || operation.state === 'interrupted',
        }} : previous)
        void queryClient.invalidateQueries({queryKey: lifecycleQueryKeys.all()})
        toast('Cleanup requested. The task is kept until cleanup completes.')
        if (onScreen) void navigate(`/tasks/${run.id}`)
        return
      }
      // Only the legacy endpoint's completed deletion means the page is gone.
      if (onScreen) void navigate('/')
    },
    onError,
  })
  const terminal = useMutation({
    mutationFn: () => openRunInCli(run.id),
    onError: (error: Error) => {
      // The legacy 409 fallback: no terminal emulator → the server sends the manual command;
      // put it on the clipboard so "no terminal" still ends with the user one paste away.
      if (error instanceof ApiError && error.command) {
        void copyToClipboard(error.command, 'No terminal found — command copied to clipboard.')
        return
      }
      onError(error)
    },
  })

  return {
    finish,
    archive,
    pin,
    markUnread,
    markRead,
    cancel,
    delete: deleteMutation,
    lifecycleDelete,
    terminal,
    confirming,
    setConfirming,
  }
}

export type RunActions = ReturnType<typeof useRunActions>

export async function copyToClipboard(text: string, doneMessage: string): Promise<void> {
  try {
    await writeClipboard(text)
    toast(doneMessage)
  } catch {
    // No clipboard access (permissions, http) — show the command itself; it is the payload.
    toast(`Run manually: ${text}`)
  }
}


/**
 * The run's "Open in…" targets: the machine's apps for its worktree, minus agent CLIs that are
 * unavailable or blocked by a worktree operation, with the run's own CLI labelled `(resume)`.
 * Shared by the header's menu and the ⌘P palette.
 */
export function useRunOpenChoices(run: ApiRun, canResume: boolean) {
  const targets = useOpenTargets()
  const providers = useProviderStatus()
  const open = useMutation({
    mutationFn: (target: string) => openRunIn(run.id, target),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const availableRunners = usableRunners(providers.data)
  // The action routes remain authoritative for a stale browser. Once the complete status has
  // arrived, hide only unavailable *agent* handoffs; editors, Finder, and file tools stay
  // available because they do not launch a provider.
  const agentAvailable = (runner: ApiRun['runner']) =>
    !providers.isSuccess || availableRunners.includes(runner ?? 'claude')
  const canResumeHere = canResume && agentAvailable(run.runner)
  const choices: OpenInChoice[] = run.worktreePath
    ? (targets.data?.targets ?? [])
        .filter((target) => {
          const runner = cliTargetRunner(target.id)
          return runner === undefined || (!run.worktreeLifecycle?.activeOperationId && agentAvailable(runner))
        })
        // Agent-CLI targets (#402): the one matching this run's own runner resumes THIS run's
        // session when one exists — label that explicitly so it reads as different from just
        // opening the editor/file-manager entries. Every other CLI (wrong backend, or no session
        // yet) still opens, just starts clean — no silent cross-backend resume attempt.
        .map((target) => {
          const resumes = cliTargetResumes(run, target.id)
          return {
            target,
            ...(resumes ? { suffix: ' (resume)', title: "Resume this run's session" } : {}),
          }
        })
    : []
  return { choices, canResumeHere, open: (target: string) => open.mutate(target) }
}

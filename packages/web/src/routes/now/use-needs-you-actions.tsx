import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { applyOverrideLocally, attentionKeys, clearAttentionOverride, setAttentionOverride } from '@/api/attention'
import { archiveRun, cancelRun, finishRun, setProjectRunRead } from '@/api/client'
import { decideManagerAction, managerKeys, markManagerRead, updateManager, useManagers } from '@/api/managers'
import { queryKeys, useHealth } from '@/api/queries'
import { answerQuestion, pauseDismiss, resumeDismiss, undoDismiss, usePendingDismissals } from '@/api/questions'
import { toast } from '@/components/ui/toaster'
import type { ManagerReferenceProject } from '@/lib/managers'
import { RunConfirmDialog } from '@/routes/task-thread/run-confirm-dialog'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import type { AttentionActions } from './now-attention'
import type { TriageActions } from './now-triage'
import { createTriageActions, questionCloser } from './now-triage-actions'
import { keyedQueue } from './now-triage-model'

const NO_MANAGERS: readonly { id: string; notify?: boolean | undefined }[] = []

/**
 * Everything a Needs you list does to its rows (spec 2026-11-23-needs-you-triage), shared by the
 * project's Now and Manager mode's Now: answer, decide, mark read, and the ✕ / ⋯ triage with its undo.
 * `stopDialog` is the Stop confirm, rendered by the caller.
 */
export function useNeedsYouActions(): {
  attentionActions: AttentionActions
  triage: TriageActions
  pendingQuestions: ReadonlySet<string>
  referenceProjects: readonly ManagerReferenceProject[]
  stopDialog: React.ReactNode
} {
  const queryClient = useQueryClient()
  const health = useHealth()
  const managers = useManagers(health.data?.capabilities?.managers === true)
  const invalidateRuns = React.useCallback(() => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }), [queryClient])
  const settle = React.useCallback(() => Promise.all([
    queryClient.invalidateQueries({ queryKey: attentionKeys.all }),
    queryClient.invalidateQueries({ queryKey: managerKeys.list }),
  ]), [queryClient])
  const attentionActions = React.useMemo<AttentionActions>(() => ({
    answer: async (item, text) => {
      if (!item.questionKey) return
      await answerQuestion(item.questionKey, text)
      await settle()
    },
    decide: async (item, decision) => {
      if (!item.managerId || !item.actionId) return
      await decideManagerAction(item.managerId, item.actionId, decision)
      await settle()
    },
    markRead: async (item) => {
      if (item.kind === 'message' && item.managerId) await markManagerRead(item.managerId)
      else if (item.projectId && item.runId) await setProjectRunRead(item.projectId, item.runId, true)
      await settle()
    },
  }), [settle])
  const referenceProjects = React.useMemo(
    () => (health.data?.projects ?? []).map((project) => ({ id: project.id, name: project.name })),
    [health.data],
  )
  const managerList = managers.data?.managers ?? NO_MANAGERS
  const pending = usePendingDismissals()
  // An errored close shows its card again, as the Questions page does.
  const pendingQuestions = React.useMemo(() => new Set(pending.filter((entry) => !entry.error).map((entry) => entry.key)), [pending])
  const [cancelling, setCancelling] = React.useState<RunRecord | null>(null)
  // Outlives the triage memo, so writes stay ordered across a managers refresh.
  const writeQueue = React.useRef(keyedQueue())
  const triage = React.useMemo<TriageActions>(() => createTriageActions({
    queryClient,
    setOverride: setAttentionOverride,
    clearOverride: clearAttentionOverride,
    applyLocally: (override) => applyOverrideLocally(queryClient, override),
    scheduleClose: questionCloser(queryClient),
    holdClose: (key, held) => (held ? pauseDismiss(key) : resumeDismiss(key)),
    undoClose: undoDismiss,
    finishRun,
    archiveRun: (id, archived) => archiveRun(id, archived),
    setManagerNotify: (id, notify) => updateManager(id, { notify }),
    managerMuted: (id) => managerList.find((manager) => manager.id === id)?.notify === false,
    confirmCancel: setCancelling,
    copy: (text) => Promise.resolve(globalThis.navigator?.clipboard?.writeText(text)),
    origin: globalThis.location?.origin ?? 'http://127.0.0.1',
    toast,
    refreshAttention: () => queryClient.invalidateQueries({ queryKey: attentionKeys.all }),
    refreshRuns: invalidateRuns,
    refreshManagers: () => queryClient.invalidateQueries({ queryKey: managerKeys.list }),
    inOrder: writeQueue.current,
  }), [queryClient, invalidateRuns, managerList])
  const stopDialog = cancelling ? (
    <RunConfirmDialog
      run={cancelling}
      confirming="cancel"
      onOpenChange={(open) => { if (!open) setCancelling(null) }}
      onConfirm={() => {
        const run = cancelling
        setCancelling(null)
        const refresh = () => Promise.all([invalidateRuns(), queryClient.invalidateQueries({ queryKey: attentionKeys.all })])
        void cancelRun(run.id).then(refresh, (error: unknown) => {
          toast(`Could not stop the task: ${error instanceof Error ? error.message : String(error)}`, { tone: 'danger' })
          // A 409 usually means it already ended: show what it is now.
          void refresh()
        })
      }}
    />
  ) : null
  return { attentionActions, triage, pendingQuestions, referenceProjects, stopDialog }
}

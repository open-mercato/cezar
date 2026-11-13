import { useMutation, useQueryClient } from '@tanstack/react-query'
import { failurePortSource, retryableWorkflowNodes, runEndedOnFailure, type ApiRun } from '@open-mercato/cezar-api-client'

import { retryRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'

export interface RetryTarget {
  id: string
  label: string
}

/** The nodes a failed workflow run can be retried from (#1733), the one that failed first. */
export function retryTargets(run: ApiRun): RetryTarget[] {
  if (!run.workflowDef || !runEndedOnFailure(run)) return []
  const nodes = retryableWorkflowNodes(run.workflowDef)
  const failed = run.steps.find((s) => s.status === 'failed' && nodes.some((n) => n.id === s.id))?.id
    ?? failurePortSource(run.graphState?.taken)
  const first = nodes.findIndex((n) => n.id === failed)
  const ordered = first > 0 ? [nodes[first]!, ...nodes.slice(0, first), ...nodes.slice(first + 1)] : nodes
  return ordered.map((n) => ({ id: n.id, label: `${n.name ?? n.id}${n.id === failed ? ' (failed)' : ''}` }))
}

/** `POST /runs/:id/retry`: re-enter the run's graph at the chosen node. */
export function useRetryRun(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (node: string) => retryRun(runId, node),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

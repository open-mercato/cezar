import { useMutation, useQueryClient } from '@tanstack/react-query'

import { promoteRun, resumeAccountHolds, startRunNow } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'

/** The queued placeholder's "Start now" (`POST /runs/:id/start-now`): skip the `maxParallel` cap. */
export function useStartRunNow(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => startRunNow(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

/** The queued placeholder's "Run First" (`POST /runs/:id/promote`): take the next free slot, never past a cap. */
export function usePromoteRun(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => promoteRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

/** The queued placeholder's "Resume now" (`POST /workspace/usage-holds/resume`): lift the account's
 *  usage-limit hold everywhere — the way out after signing the profile into another login. */
export function useResumeAccountHolds() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (account: string) => resumeAccountHolds(account),
    onSuccess: ({ released }) => {
      toast(released === 0
        ? 'Usage-limit hold lifted. No task in an open project was waiting on it.'
        : `Usage-limit hold lifted for ${released} ${released === 1 ? 'task' : 'tasks'}. Paused tasks resume first; new tasks start once one of them reaches the provider.`)
      return queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { promoteRun, startRunNow } from '@/api/client'
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

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { finishRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'

/**
 * THE finish action (`POST /api/runs/:id/finish`) — one implementation for its two meanings
 * (run-actions.ts `finishTitle`): waiting → close the session; review → accept the changes
 * without a PR. The header's Finish button and the review panel's ✓ Accept both sit on this
 * hook so the review-gate semantics can never fork between the two surfaces.
 */
export function useFinishRun(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => finishRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

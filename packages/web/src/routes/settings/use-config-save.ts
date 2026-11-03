import { useMutation, useQueryClient } from '@tanstack/react-query'

import { putConfig } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { SetConfigInput } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

/**
 * The one `PUT /api/v1/config` mutation every project settings section shares (Agents,
 * Instructions, Tasks). The PUT answers the full knob shape, which lands straight in the
 * `config` query — the readback is the server's own truth, not an optimistic guess. The same
 * knobs surface elsewhere (defaultRunner in /api/health, baseBranch in /api/repo), so both are
 * refreshed too; the composer and the Git view must agree immediately.
 */
export function useConfigSave() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.config, result)
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    },
    // 400/409/500 alike: the server's own words, verbatim (the repo-wide error doctrine).
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
}

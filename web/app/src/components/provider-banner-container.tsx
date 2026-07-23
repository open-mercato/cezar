import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'

import { putWorkspaceUiState } from '@/api/client'
import {
  useProviderStatus,
  useWorkspaceUiState,
  workspaceQueryKeys,
} from '@/api/queries'
import type { WorkspaceUiState } from '@/api/types'
import { ProviderBanner } from '@/components/provider-banner'
import { toast } from '@/components/ui/toaster'
import {
  mergeProviderAuthDismissals,
  providerAuthDismissals,
  type ProviderAuthIncident,
} from '@/lib/provider-auth-alert'

function workspaceUiState(value: unknown): WorkspaceUiState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as WorkspaceUiState
}

export function ProviderBannerContainer() {
  const providers = useProviderStatus()
  const uiState = useWorkspaceUiState()
  const queryClient = useQueryClient()
  const writeChain = useRef<Promise<unknown>>(Promise.resolve())
  const latestWrite = useRef(0)

  const dismiss = useCallback(
    (incidents: readonly ProviderAuthIncident[]) => {
      const key = workspaceQueryKeys.uiState
      const previous = workspaceUiState(queryClient.getQueryData<unknown>(key))
      const currentDismissals = providerAuthDismissals(
        previous?.dismissedProviderAuthFailures,
      )
      const nextDismissals = mergeProviderAuthDismissals(currentDismissals, incidents)
      const optimistic = {
        ...previous,
        dismissedProviderAuthFailures: nextDismissals,
      }
      queryClient.setQueryData(key, optimistic)

      const seq = ++latestWrite.current
      writeChain.current = writeChain.current.then(async () => {
        try {
          const merged = await putWorkspaceUiState({
            dismissedProviderAuthFailures: nextDismissals,
          })
          if (seq === latestWrite.current) queryClient.setQueryData(key, merged)
        } catch (error: unknown) {
          if (seq === latestWrite.current) {
            if (previous === undefined) {
              queryClient.removeQueries({ queryKey: key, exact: true })
            } else {
              queryClient.setQueryData(key, previous)
            }
            void queryClient.invalidateQueries({ queryKey: key })
            toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          }
        }
      })
    },
    [queryClient],
  )

  return (
    <ProviderBanner
      status={providers.data}
      pending={providers.isPending}
      error={providers.isError}
      dismissals={providerAuthDismissals(
        workspaceUiState(uiState.data)?.dismissedProviderAuthFailures,
      )}
      onDismissAuthFailures={dismiss}
    />
  )
}

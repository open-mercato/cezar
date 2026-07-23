import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'

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
  const pendingWrites = useRef(0)
  const lastConfirmed = useRef<WorkspaceUiState | undefined>(
    workspaceUiState(uiState.data),
  )

  useEffect(() => {
    if (pendingWrites.current === 0) {
      lastConfirmed.current = workspaceUiState(uiState.data)
    }
  }, [uiState.data])

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
      pendingWrites.current += 1
      queryClient.setQueryData(key, optimistic)

      const seq = ++latestWrite.current
      writeChain.current = writeChain.current.then(async () => {
        try {
          const merged = await putWorkspaceUiState({
            dismissedProviderAuthFailures: nextDismissals,
          })
          lastConfirmed.current = workspaceUiState(merged)
          if (seq === latestWrite.current) queryClient.setQueryData(key, merged)
        } catch (error: unknown) {
          if (seq === latestWrite.current) {
            if (lastConfirmed.current === undefined) {
              queryClient.removeQueries({ queryKey: key, exact: true })
            } else {
              queryClient.setQueryData(key, lastConfirmed.current)
            }
            void queryClient.invalidateQueries({ queryKey: key })
            toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          }
        } finally {
          pendingWrites.current -= 1
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

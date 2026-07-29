import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

import { putWorkspaceUiState } from '@/api/client'
import {
  useProjects,
  useWorkspaceUiState,
  workspaceQueryKeys,
} from '@/api/queries'
import type {
  WorkspaceLastLocation,
  WorkspaceUiState,
} from '@open-mercato/cezar-api-client'
import { locationToSave, sameLastLocation } from '@/lib/last-location'

export const LAST_LOCATION_WRITE_DEBOUNCE_MS = 400

/**
 * Remembers settled project-scoped navigation for the next exact-bare-root launch.
 *
 * This controller lives once beside the routed tree: global settings and legacy paths are
 * ignored by `locationToSave`, while valid registered project URLs optimistically update the
 * shared workspace cache and coalesce into one shallow top-level PUT.
 */
export function LastLocationController(): null {
  const queryClient = useQueryClient()
  const location = useLocation()
  const projects = useProjects()
  const uiState = useWorkspaceUiState()
  const pending = useRef<WorkspaceLastLocation | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writing = useRef(false)

  const flush = useCallback(function flushPending() {
    timer.current = null
    if (writing.current) return
    const lastLocation = pending.current
    if (lastLocation === null) return
    pending.current = null
    writing.current = true

    void putWorkspaceUiState({ lastLocation })
      .then((merged) => {
        const current = queryClient.getQueryData<WorkspaceUiState>(
          workspaceQueryKeys.uiState,
        )
        const currentLocation = current?.lastLocation
        if (
          currentLocation === undefined ||
          sameLastLocation(currentLocation, lastLocation)
        ) {
          queryClient.setQueryData(workspaceQueryKeys.uiState, merged)
        } else {
          queryClient.setQueryData(workspaceQueryKeys.uiState, {
            ...merged,
            lastLocation: currentLocation,
          })
        }
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
      })
      .finally(() => {
        writing.current = false
        // A debounce that expired while this write was active left the latest candidate
        // pending with no timer. Start it now, after the older server write has settled.
        if (pending.current !== null && timer.current === null) flushPending()
      })
  }, [queryClient])

  useEffect(
    () => () => {
      if (timer.current === null) return
      clearTimeout(timer.current)
      flush()
    },
    [flush],
  )

  useEffect(() => {
    // Do not build an optimistic document before the authoritative workspace state has loaded:
    // doing so would replace a still-in-flight response with a one-key cache object.
    if (uiState.data === undefined) return

    const next = locationToSave(location, projects.data)
    if (next === null) return

    const current = queryClient.getQueryData<WorkspaceUiState>(
      workspaceQueryKeys.uiState,
    )
    if (sameLastLocation(current?.lastLocation, next)) return

    queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, {
      ...current,
      lastLocation: next,
    })
    pending.current = next
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, LAST_LOCATION_WRITE_DEBOUNCE_MS)
  }, [
    flush,
    location.hash,
    location.pathname,
    location.search,
    projects.data,
    queryClient,
    uiState.data,
  ])

  return null
}

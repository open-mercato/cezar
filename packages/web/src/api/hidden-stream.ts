import type { QueryClient } from '@tanstack/react-query'

import { normalizeNotifications, notificationSupport } from '@/lib/notifications'
import { workspaceQueryKeys } from './queries'

/**
 * A hidden tab may only drop the workspace stream when nothing in it needs the stream to keep
 * working: browser run notifications fire from a hidden tab off the runs cache this stream patches.
 */
export function hiddenTabNeedsWorkspaceStream(queryClient: QueryClient): boolean {
  // A missing cache reads as "notifications off"; with permission granted that would drop a stream
  // the user wants (#1782), so keep it until the settings load.
  if (notificationSupport() === 'granted' && hiddenTabAwaitsUiState(queryClient)) return true
  const state = queryClient.getQueryData<{ notifications?: unknown }>(workspaceQueryKeys.uiState)
  return normalizeNotifications(state?.notifications).enabled && notificationSupport() === 'granted'
}

/** Permission is granted but the notification setting has not loaded (yet, or ever). */
export function hiddenTabAwaitsUiState(queryClient: QueryClient): boolean {
  return notificationSupport() === 'granted' && queryClient.getQueryData(workspaceQueryKeys.uiState) === undefined
}

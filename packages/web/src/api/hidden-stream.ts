import type { QueryClient } from '@tanstack/react-query'

import { normalizeNotifications, notificationSupport } from '@/lib/notifications'
import { workspaceQueryKeys } from './queries'

/**
 * A hidden tab may only drop the workspace stream when nothing in it needs the stream to keep
 * working: browser run notifications fire from a hidden tab off the runs cache this stream patches.
 */
export function hiddenTabNeedsWorkspaceStream(queryClient: QueryClient): boolean | undefined {
  if (notificationSupport() !== 'granted') return false
  const state = queryClient.getQueryData<{ notifications?: unknown }>(workspaceQueryKeys.uiState)
  if (state === undefined) return undefined
  return normalizeNotifications(state.notifications).enabled
}

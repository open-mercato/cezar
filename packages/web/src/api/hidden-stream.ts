import type { QueryClient } from '@tanstack/react-query'

import { normalizeNotifications, notificationSupport } from '@/lib/notifications'
import { workspaceQueryKeys } from './queries'

/**
 * A hidden tab may only drop the workspace stream when nothing in it needs the stream to keep
 * working: browser run notifications fire from a hidden tab off the runs cache this stream patches.
 */
export function hiddenTabNeedsWorkspaceStream(queryClient: QueryClient): boolean {
  const state = queryClient.getQueryData<{ notifications?: unknown }>(workspaceQueryKeys.uiState)
  return normalizeNotifications(state?.notifications).enabled && notificationSupport() === 'granted'
}

import type { RunRecord } from '@open-mercato/cezar-api-client'
import { useEffect } from 'react'

import { isNeedsYouStatus } from './attention'
import { managerAttention, type AttentionCounts } from './managers'
import { isUnread } from './read-state'

/**
 * Unread count badge on the installed app icon (W3C Badging API).
 *
 * Calls navigator.setAppBadge(n) when n > 0 and navigator.clearAppBadge() when n <= 0.
 * Feature-detected and quiet: a no-op where unsupported (e.g. Safari tab, Firefox), and
 * degrades cleanly if the browser throws or denies permission.
 */

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function isAppBadgeSupported(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as BadgingNavigator
  return typeof nav.setAppBadge === 'function' && typeof nav.clearAppBadge === 'function'
}

export async function updateAppBadge(count: number): Promise<void> {
  if (typeof navigator === 'undefined') return
  const nav = navigator as BadgingNavigator
  try {
    if (count > 0) {
      if (typeof nav.setAppBadge === 'function') {
        await nav.setAppBadge(count)
      }
    } else {
      if (typeof nav.clearAppBadge === 'function') {
        await nav.clearAppBadge()
      }
    }
  } catch {
    // Degrade quietly: badging is an enhancement, never a throw.
  }
}

/**
 * Deduplicated count of tasks needing user attention:
 * - tasks waiting on the user (in review, waiting on answer/question, paused)
 * - finished tasks that are unread (cleared when opened)
 * Each task is counted at most once, and archived tasks are ignored.
 */
export function countUnreadTasks(runs: readonly RunRecord[] | undefined): number {
  let count = 0
  for (const run of runs ?? []) {
    if (!run.archived && (isNeedsYouStatus(run) || isUnread(run))) {
      count += 1
    }
  }
  return count
}

/**
 * Count of manager chats with unread replies or pending approvals/questions.
 * One chat = one unit, regardless of how many messages it holds.
 * Reading the chat or deciding approvals clears its unit.
 */
export function countUnreadManagers(managers: readonly AttentionCounts[] | undefined): number {
  let count = 0
  for (const manager of managers ?? []) {
    if (managerAttention(manager) !== null) {
      count += 1
    }
  }
  return count
}

export function unreadBadgeCount(
  runs: readonly RunRecord[] | undefined,
  managers: readonly AttentionCounts[] | undefined,
): number {
  return countUnreadTasks(runs) + countUnreadManagers(managers)
}

/**
 * Keeps the installed app icon badge synced with the unread count.
 * Updates on count changes, and re-applies whenever the tab becomes visible again.
 */
export function useAppBadge(count: number): void {
  useEffect(() => {
    updateAppBadge(count)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        updateAppBadge(count)
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [count])
}

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { isNeedsYouStatus } from './attention'
import { sortRuns } from './task-groups'

/**
 * Walking tasks with the keyboard, Slack's way (spec 2026-10-17-task-palette, "Switching by
 * arrow"): ⌥↑/⌥↓ step through the sidebar's rows in sidebar order, ⌥⇧↑/⌥⇧↓ through the ones that
 * need you. The ring is the active view's `sortRuns` order — Pinned first, then Needs you — so
 * what you step through is what the sidebar shows, in the order it shows it.
 */

export type RingDirection = 'previous' | 'next'

/** The run ids ⌥-arrows walk, in order. `needsYouOnly` is the ⇧ ring. */
export function taskRing(runs: readonly RunRecord[], needsYouOnly: boolean): string[] {
  return sortRuns(runs, 'active')
    .filter((run) => !needsYouOnly || isNeedsYouStatus(run))
    .map((run) => run.id)
}

/**
 * Where one ⌥-arrow lands from `currentId`, or null with nothing to go to. Wraps at both ends.
 * Off the ring — on the Tasks table, or on a task that no longer needs you with ⇧ held —
 * `next` starts at the top and `previous` at the bottom, so the first press always lands.
 */
export function stepTaskRing(ring: readonly string[], currentId: string | undefined, direction: RingDirection): string | null {
  if (ring.length === 0) return null
  const at = currentId === undefined ? -1 : ring.indexOf(currentId)
  if (at === -1) return direction === 'next' ? ring[0]! : ring[ring.length - 1]!
  if (ring.length === 1) return null
  return ring[(at + (direction === 'next' ? 1 : -1) + ring.length) % ring.length]!
}

import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { managerRowPreview } from './managers'

/** Pure rules behind the manager heads (design 2026-11 "Manager mode", section 3). */

export type HeadKind = 'approval' | 'question' | 'news'

type HeadCounts = Pick<ManagerSummary, 'unread' | 'important' | 'pendingActions' | 'pendingQuestions'>

/**
 * Why a manager surfaces, or null. A request needs you until its chat is opened (which clears
 * `unread`) or it is answered; news is only what the manager judged important, so a routine
 * "next run in 40 min" never surfaces.
 */
export function headKind(manager: HeadCounts): HeadKind | null {
  if (manager.unread > 0 && manager.pendingActions > 0) return 'approval'
  if (manager.unread > 0 && manager.pendingQuestions > 0) return 'question'
  return manager.important > 0 ? 'news' : null
}

/** What "something new" means: the same sum the browser notification rises on. */
export function headCount(manager: HeadCounts): number {
  return manager.pendingActions + manager.pendingQuestions + manager.important
}

export const needsYou = (kind: HeadKind): boolean => kind !== 'news'

export const HEAD_KIND_LABEL: Record<HeadKind, string> = { approval: 'Approval', question: 'Question', news: 'News' }

/** "Scout needs an approval" on the phone pill. */
export const HEAD_KIND_PHRASE: Record<HeadKind, string> = {
  approval: 'needs an approval',
  question: 'has a question',
  news: 'has news',
}

const ANNOUNCE_VERB: Record<HeadKind, string> = {
  approval: 'asks for an approval',
  question: 'has a question',
  news: 'has news',
}

/** The bubble's quote. The summary carries no card text, so a request quotes the latest line. */
export function headLine(manager: ManagerSummary, kind: HeadKind): string {
  if (kind === 'news') return manager.headline ?? manager.preview ?? 'New message'
  return manager.preview ?? managerRowPreview(manager)
}

/** "Scout asks for an approval: merge #2081". */
export function headAnnouncement(manager: ManagerSummary, kind: HeadKind): string {
  return `${manager.name} ${ANNOUNCE_VERB[kind]}: ${headLine(manager, kind)}`
}

// ---- what this tab has shown (sessionStorage) -----------------------------------------------

/** Per manager, the `headCount` this tab last showed: a reload must not announce it again. */
export const HEADS_SEEN_KEY = 'cez-manager-heads-seen'
/** Per manager, the `headCount` it had when Later was pressed: hidden until it rises. */
export const HEADS_LATER_KEY = 'cez-manager-heads-later'

export type HeadMemory = Readonly<Record<string, number>>

export function readHeadMemory(key: string): HeadMemory {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch {
    return {}
  }
}

export function writeHeadMemory(key: string, memory: HeadMemory): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(memory))
  } catch {
    // Storage off: the heads still work for this page, they just forget on reload.
  }
}

export function laterHidden(later: HeadMemory, manager: ManagerSummary): boolean {
  const at = later[manager.id]
  return at !== undefined && headCount(manager) <= at
}

/** Lower each Later mark to the current count, so the next rise shows; drop it once nothing waits.
 *  Returns the same object when nothing changed. */
export function settleLater(later: HeadMemory, managers: readonly ManagerSummary[]): HeadMemory {
  const next: Record<string, number> = {}
  let changed = false
  for (const [id, at] of Object.entries(later)) {
    const manager = managers.find((row) => row.id === id)
    const count = manager ? headCount(manager) : 0
    if (count === 0) {
      changed = true
      continue
    }
    next[id] = Math.min(at, count)
    if (next[id] !== at) changed = true
  }
  return changed ? next : later
}

export interface Head {
  manager: ManagerSummary
  kind: HeadKind
}

/** The heads in the corner, oldest first: the newest sits at the bottom. */
export function restingHeads(managers: readonly ManagerSummary[], later: HeadMemory): Head[] {
  const at = (manager: ManagerSummary) => Date.parse(manager.lastActivityAt ?? manager.createdAt) || 0
  return managers
    .flatMap((manager) => {
      const kind = headKind(manager)
      return kind && !laterHidden(later, manager) ? [{ manager, kind }] : []
    })
    .sort((a, b) => at(a.manager) - at(b.manager))
}

/** Heads whose count rose past what this tab showed, plus the memory to store next. */
export function diffArrivals(seen: HeadMemory, managers: readonly ManagerSummary[], heads: readonly Head[]): { arrivals: Head[]; seen: HeadMemory } {
  const arrivals = heads.filter((head) => headCount(head.manager) > (seen[head.manager.id] ?? 0))
  return { arrivals, seen: Object.fromEntries(managers.map((manager) => [manager.id, headCount(manager)])) }
}

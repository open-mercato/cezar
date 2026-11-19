/**
 * "Your messages" navigation (spec 2026-11-17-my-message-navigation): the pure half — what the
 * list holds, where each message sits against the viewport, and which one ▲ / ▼ reach.
 */

export interface MyMessage {
  /** The view's own key for the message: a thread row key, a manager message id. */
  id: string
  /** Transcript order; ties keep insertion order. */
  order: number
  ts?: string
  text: string
  images: number
  files: number
  /** Not delivered yet: shown, but never a jump target before it renders. */
  pending?: 'queued'
}

/** Where a message is: on screen (its rect), or off it above or below. */
export type MyMessagePlace = { top: number; bottom: number } | 'above' | 'below'

export interface MyMessageTargets {
  prev?: MyMessage
  next?: MyMessage
  /** Every message with any part on screen — the list's markers. There is no single "current". */
  onScreen: string[]
}

/** A jump parks its target this far below the viewport's top. */
export const JUMP_OFFSET_PX = 24

/**
 * ▲ is the nearest message whose top is above the viewport's top, ▼ the nearest below it. The
 * band a jump parks its target in (top + {@link JUMP_OFFSET_PX}) belongs to neither side, so
 * pressing ▲ again walks on instead of re-landing on the same message.
 */
export function myMessageTargets(
  items: readonly MyMessage[],
  place: (item: MyMessage) => MyMessagePlace,
  viewport: { top: number; bottom: number },
): MyMessageTargets {
  const onScreen: string[] = []
  let prev: MyMessage | undefined
  let next: MyMessage | undefined
  for (const item of items) {
    const where = place(item)
    if (where === 'above') {
      prev = item
      continue
    }
    if (where === 'below') {
      next ??= item
      continue
    }
    if (where.bottom > viewport.top + 4 && where.top < viewport.bottom) onScreen.push(item.id)
    if (where.top < viewport.top + JUMP_OFFSET_PX / 2) prev = item
    else if (where.top > viewport.top + JUMP_OFFSET_PX + 8) next ??= item
  }
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}), onScreen }
}

/** The server's index plus what the view has loaded since; the loaded copy wins (fuller text). */
export function mergeMyMessages(indexed: readonly MyMessage[], loaded: readonly MyMessage[]): MyMessage[] {
  const byId = new Map<string, MyMessage>()
  for (const item of indexed) byId.set(item.id, item)
  for (const item of loaded) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => a.order - b.order)
}

/**
 * The list's one-line form of a message: markdown marks dropped, line breaks folded to " · ",
 * whitespace collapsed. Two-line clamping is CSS's job.
 */
export function myMessagePreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?=\S))/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .split(/\s*\n+\s*/)
    .filter((line) => line.trim() !== '')
    .join(' · ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Splits attachment URLs or names into images and files by name (issue 950). */
export function countAttachments(names: readonly string[], isImage: (name: string) => boolean): { images: number; files: number } {
  const images = names.filter((name) => isImage(name.split('?')[0]?.split('/').pop() ?? '')).length
  return { images, files: names.length - images }
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

/** The sticky header a message files under: Today, Yesterday, or a short date. */
export function myMessageDay(ts: string | undefined, now = new Date()): string {
  if (ts === undefined) return 'Earlier'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return 'Earlier'
  if (dayKey(date) === dayKey(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

export function myMessageTime(ts: string | undefined): string {
  if (ts === undefined) return ''
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

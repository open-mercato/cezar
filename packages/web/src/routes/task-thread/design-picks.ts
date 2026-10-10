import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { putRunDraft } from '@/api/client'
import { queryKeys, useRunDrafts } from '@/api/queries'
import { DRAFT_TEXT_MAX, type RunDraftsResponse } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

/**
 * Design Mode picks (spec `.ai/specs/2026-10-09-design-mode.md`) — elements the user clicked in
 * the Browser column's app preview. Like the diff comments they are NOT sent one by one: they
 * pile up as chips in the thread composer and ride the next message, so the user points at
 * things first and says what they want once.
 *
 * Stored in the run's draft store under the `design-picks` surface, as JSON in the entry's
 * `text`, which is what carries them from the Browser column to the Chat column, across a reload,
 * and across a layout switch that unmounts both.
 *
 * Deliberately simpler than `useDiffComments`: one in-memory list per run that every host
 * subscribes to, seeded ONCE from the server and written through. There is no three-way merge
 * with another window's list — the last window to pick wins. A pick has no body to edit and
 * costs one click to redo, so the machinery that protects a typed review is not worth carrying
 * here; if that ever stops being true, `mergeComments` is the shape to borrow.
 */

export const DESIGN_PICKS_SURFACE = 'design-picks'

/** More than this in one message is a page dump, not a selection. */
export const DESIGN_PICKS_MAX = 12

/** What `POST /runs/:id/messages` accepts — the same cap `messageWithReview` guards. */
const MESSAGE_TEXT_MAX = 100_000

export interface DesignPickRect {
  x: number
  y: number
  width: number
  height: number
}

/** One picked element, as the picker script described it. */
export interface NewDesignPick {
  /** The page it was picked on — the app's real address, never the proxy's. */
  url: string
  selector: string
  tag: string
  text: string
  html: string
  styles: Record<string, string>
  rect: DesignPickRect
  viewport: { width: number; height: number }
  /** Nearest first; empty outside a development build of React or Vue. */
  components: string[]
  /** `file:line` when the framework exposes it, else `''`. */
  source: string
  /**
   * The picker's handle on the live element, so the page can keep it framed and numbered while
   * the pick is part of a note. Valid only for the document it was picked in — after a reload it
   * names nothing, and the pick simply has no frame.
   */
  mark?: string
}

export interface DesignPick extends NewDesignPick {
  id: string
}

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0)

/**
 * A pick out of whatever arrived — from the framed page's `postMessage` or from the draft store.
 *
 * Defensive on purpose and bounded on every field: the sender is a page cezar does not control,
 * and what it sends ends up in a prompt. Anything that is not recognisably an element answers
 * `null`.
 */
export function parseDesignPick(raw: unknown): NewDesignPick | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const selector = str(r.selector, 400)
  const tag = str(r.tag, 40)
  if (selector === '' || tag === '') return null
  const rect = (r.rect ?? {}) as Record<string, unknown>
  const viewport = (r.viewport ?? {}) as Record<string, unknown>
  const styles: Record<string, string> = {}
  if (r.styles !== null && typeof r.styles === 'object') {
    for (const [name, value] of Object.entries(r.styles as Record<string, unknown>).slice(0, 30)) {
      if (typeof value === 'string' && /^[a-z-]{1,40}$/.test(name)) styles[name] = value.slice(0, 160)
    }
  }
  return {
    url: str(r.url, 2000),
    selector,
    tag,
    text: str(r.text, 200),
    html: str(r.html, 1600),
    styles,
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    viewport: { width: num(viewport.width), height: num(viewport.height) },
    components: Array.isArray(r.components)
      ? r.components.filter((name): name is string => typeof name === 'string').slice(0, 6).map((name) => name.slice(0, 80))
      : [],
    source: str(r.source, 300),
    ...(typeof r.mark === 'string' && /^[a-z0-9-]{1,24}$/.test(r.mark) ? { mark: r.mark } : {}),
  }
}

export function parseDesignPicks(text: string): DesignPick[] {
  if (text === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: DesignPick[] = []
  for (const item of raw as unknown[]) {
    const pick = parseDesignPick(item)
    const id = (item as { id?: unknown } | null)?.id
    if (pick && typeof id === 'string' && id !== '') out.push({ ...pick, id })
  }
  return out
}

/** What a chip calls a pick: the innermost component when there is one, else the selector's tail. */
export function pickLabel(pick: Pick<DesignPick, 'selector' | 'components' | 'tag'>): string {
  const tail = pick.selector.split(' > ').at(-1) ?? pick.tag
  return pick.components[0] ? `${pick.components[0]} · ${tail}` : tail
}

/** The line that opens the block in a sent message. */
export const DESIGN_HEADING = 'Elements selected in the app preview:'

/** A fence longer than any backtick run inside, so markup containing ``` cannot close it early. */
function fence(code: string, lang: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${code}\n${ticks}`
}

const indent = (body: string): string =>
  body
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')

/** What the agent receives: one block, every element with where it is, what renders it and its
 *  markup — enough to find it in the source without a screenshot. */
export function formatDesignPicks(picks: readonly DesignPick[]): string {
  if (picks.length === 0) return ''
  const blocks = picks.map((pick) => {
    const lines = [`- \`${pick.selector}\`${pick.url ? ` on ${pick.url}` : ''}`]
    if (pick.components.length > 0) {
      // Outermost first reads like a path into the tree.
      lines.push(`  component: ${[...pick.components].reverse().join(' › ')}${pick.source ? ` (${pick.source})` : ''}`)
    } else if (pick.source) {
      lines.push(`  source: ${pick.source}`)
    }
    lines.push(
      `  box: ${pick.rect.width}×${pick.rect.height} at ${pick.rect.x},${pick.rect.y} (viewport ${pick.viewport.width}×${pick.viewport.height})`,
    )
    if (pick.text) lines.push(`  text: ${JSON.stringify(pick.text)}`)
    const styles = Object.entries(pick.styles)
    if (styles.length > 0) lines.push(`  styles: ${styles.map(([name, value]) => `${name}: ${value}`).join('; ')}`)
    return `${lines.join('\n')}\n\n${indent(fence(pick.html, 'html'))}`
  })
  return `${DESIGN_HEADING}\n\n${blocks.join('\n\n')}`
}

/**
 * The message that carries the picks: whatever it already holds, then the elements. The typed
 * text stays first for the reason `withDiffComments` gives — a `/skill` is only expanded when the
 * message STARTS with it. Throws when the result would be refused by the server, so the host
 * keeps both the message and the picks.
 */
export function messageWithDesignPicks(text: string, picks: readonly DesignPick[]): string {
  const block = formatDesignPicks(picks)
  if (block === '') return text
  const message = text.trim() === '' ? block : `${text}\n\n${block}`
  if (message.length > MESSAGE_TEXT_MAX) {
    throw new Error(
      `Too long with the ${picks.length === 1 ? 'selected element' : `${picks.length} selected elements`} attached — remove some of them.`,
    )
  }
  return message
}

export interface DesignPicks {
  /** The stored picks ARRIVED. Before that an `add` would replace whatever the server holds. */
  ready: boolean
  picks: DesignPick[]
  /** `false` when the pick was not kept, with a toast saying why. */
  add: (pick: NewDesignPick) => boolean
  remove: (id: string) => void
  /** Hand the picks to a send; exactly the ones it carried are dropped once it lands. A failed
   *  send keeps them all. */
  submit: <T>(action: (picks: DesignPick[]) => Promise<T>) => Promise<T>
}

interface PicksStore {
  lists: Map<string, DesignPick[]>
  listeners: Map<string, Set<() => void>>
  /** One write chain per run, so two quick picks land in order. */
  chains: Map<string, Promise<unknown>>
}
const stores = new WeakMap<object, PicksStore>()
function storeFor(client: object): PicksStore {
  let store = stores.get(client)
  if (!store) {
    store = { lists: new Map(), listeners: new Map(), chains: new Map() }
    stores.set(client, store)
  }
  return store
}

const NO_PICKS: DesignPick[] = []

const serialize = (picks: readonly DesignPick[]): string => (picks.length === 0 ? '' : JSON.stringify(picks))

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function useDesignPicks(runId: string): DesignPicks {
  const queryClient = useQueryClient()
  const store = storeFor(queryClient)
  const drafts = useRunDrafts(runId === '' ? undefined : runId)
  const storedText = drafts.data?.surfaces?.[DESIGN_PICKS_SURFACE]?.text
  const serverPicks = useMemo(() => parseDesignPicks(typeof storedText === 'string' ? storedText : ''), [storedText])

  const subscribe = useCallback(
    (listener: () => void) => {
      const set = store.listeners.get(runId) ?? new Set()
      set.add(listener)
      store.listeners.set(runId, set)
      return () => set.delete(listener)
    },
    [runId, store],
  )
  const live = useSyncExternalStore(subscribe, () => store.lists.get(runId))

  // Seeded from the FIRST listing only. A later one is not merged in: a send invalidates the
  // run's queries, and a refetch answered before the clearing write landed would put the picks
  // that were just sent straight back (the same trap `useDiffComments` documents).
  useEffect(() => {
    if (!drafts.isSuccess || store.lists.get(runId) !== undefined) return
    store.lists.set(runId, serverPicks)
    store.listeners.get(runId)?.forEach((listener) => listener())
  }, [drafts.isSuccess, runId, serverPicks, store])

  const ready = live !== undefined || drafts.isSuccess
  const picks = live ?? (drafts.isSuccess ? serverPicks : NO_PICKS)

  /** The list as it stands NOW — never a render's snapshot, which a send outlives. */
  const current = useCallback((): DesignPick[] => store.lists.get(runId) ?? serverPicks, [runId, serverPicks, store])

  const write = useCallback(
    (next: DesignPick[]) => {
      store.lists.set(runId, next)
      store.listeners.get(runId)?.forEach((listener) => listener())
      const text = serialize(next)
      // Mirrored into the cached listing so a later mount, or a reload's first read, agrees.
      queryClient.setQueryData<RunDraftsResponse>(queryKeys.runs.drafts(runId), (listing) => {
        const surfaces = { ...(listing?.surfaces ?? {}) }
        if (text === '') delete surfaces[DESIGN_PICKS_SURFACE]
        else surfaces[DESIGN_PICKS_SURFACE] = { text, images: [], updatedAt: new Date().toISOString() }
        return { surfaces }
      })
      // In order and silent on failure, like every draft write. Each step saves the list as it
      // stands WHEN IT RUNS, so a burst of picks coalesces into the latest.
      const chained = (store.chains.get(runId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => putRunDraft(runId, DESIGN_PICKS_SURFACE, { text: serialize(store.lists.get(runId) ?? next), images: [] }))
        .catch(() => {})
      store.chains.set(runId, chained)
    },
    [queryClient, runId, store],
  )

  const add = useCallback(
    (pick: NewDesignPick): boolean => {
      if (!ready) {
        toast('Still loading this task — pick the element again in a moment.')
        return false
      }
      const now = current()
      if (now.length >= DESIGN_PICKS_MAX) {
        toast(`${DESIGN_PICKS_MAX} elements are already selected — send them or remove some first.`, { tone: 'danger' })
        return false
      }
      const next = [...now, { ...pick, id: newId() }]
      // The store refuses an over-cap entry and a refused draft write is silent by design, so
      // the pick would look kept and be gone after a reload.
      if (serialize(next).length > DRAFT_TEXT_MAX) {
        toast('Too much selected to keep as a draft — send what you have first.', { tone: 'danger' })
        return false
      }
      write(next)
      return true
    },
    [current, ready, write],
  )

  const remove = useCallback((id: string) => write(current().filter((pick) => pick.id !== id)), [current, write])

  const submit = useCallback(
    async <T>(action: (held: DesignPick[]) => Promise<T>): Promise<T> => {
      const held = current()
      const result = await action(held)
      if (held.length > 0) {
        // Only what was SENT goes: a pick made while the send was in flight stays for the next one.
        const sent = new Set(held.map((pick) => pick.id))
        write(current().filter((pick) => !sent.has(pick.id)))
      }
      return result
    },
    [current, write],
  )

  return { ready, picks, add, remove, submit }
}

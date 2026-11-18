import { createHash } from 'node:crypto'
import type { ChatSessionEvent, ExtensionContext } from '@open-mercato/cezar-extension-sdk'

export type Post = { id: string; user_id: string; channel_id: string; message: string; create_at: number; delete_at: number; root_id: string; type: string }
export type Channel = { id: string; type: 'D' | 'G' | 'O' | 'P'; delete_at: number }
/** Rows the session accepts in order; a row without an event only advances the checkpoint. */
export type Batch = { sequence: number; event?: ChatSessionEvent }[]
type Scan = { floor: number; until: number; page: number; seen: Record<string, number>; staged?: Post[] }
type Cursor = { version: 1; sequence: number; channel: number; scans: Record<string, Scan>; pending: Batch; ready?: Batch }

/** One page per call, persisted BEFORE returning. Stage the whole catch-up before
 * sequencing oldest-first; reversing individual newest-first pages is insufficient.
 * Only the host's checkpoint acknowledges emitted rows.
 * Page-number reads retain timestamp ties (before/after post queries may exclude them).
 * Re-scans overlap at the time boundary; stable IDs suppress those duplicates locally. */
export async function receivePage(options: {
  storage: ExtensionContext['storage']; server: string; bot: string; started: number; after: number | null
  channels(): Promise<Channel[]>
  page(channel: string, page: number): Promise<{ order: string[]; posts: Record<string, Post> }>
  normalize(post: Post, channel: Channel): Batch[number]['event'] | undefined
}): Promise<Batch> {
  const { storage, after } = options
  const key = 'poll-v1-' + createHash('sha256').update(options.server + '/' + options.bot).digest('hex')
  const stored = await storage.get(key)
  const cursor = (stored ?? { version: 1, sequence: Math.max(after ?? 0, options.started), channel: 0, scans: {}, pending: [] }) as Cursor
  if (cursor.version !== 1 || !Number.isSafeInteger(cursor.sequence) || !Array.isArray(cursor.pending)) throw Error('Invalid Mattermost cursor')
  cursor.pending = cursor.pending.filter(row => after === null || row.sequence > after)
  if (cursor.pending.length) return cursor.pending
  if (cursor.ready?.length) {
    cursor.pending = cursor.ready.splice(0, 100)
    await storage.set(key, cursor)
    return cursor.pending
  }
  const channels = await options.channels()
  if (!channels.length) return []
  // Joined-channel churn must not accumulate unbounded historical scan state.
  const joined = new Set(channels.map(channel => channel.id))
  cursor.scans = Object.fromEntries(Object.entries(cursor.scans).filter(([id]) => joined.has(id)))
  const channel = channels[cursor.channel % channels.length]!
  const scan = cursor.scans[channel.id] ??= { floor: Math.min(after ?? options.started, options.started), until: Date.now(), page: 0, seen: {} }
  const result = await options.page(channel.id, scan.page)
  const posts = result.order.map(id => result.posts[id]!).filter(Boolean)
  if (posts.length > 100) throw Error('Oversized Mattermost page')
  const staged = scan.staged ??= []
  for (const post of posts) {
    if (post.create_at < scan.floor || scan.seen[post.id] !== undefined) continue
    // Bound storage, including a pathological timestamp tie. Refuse rather than evict
    // unacknowledged/boundary IDs and silently lose or re-execute commands.
    if (Object.keys(scan.seen).length >= 10_000) throw Error('Mattermost catch-up exceeds 10000 posts per channel')
    scan.seen[post.id] = post.create_at
    staged.push(post)
  }
  if (posts.length < 100 || posts.some(post => post.create_at < scan.floor)) {
    // Timestamp ties have no intrinsic chronology; use a stable ID tie-breaker
    // across the entire scan, independent of page boundaries and worker restarts.
    staged.sort((a, b) => a.create_at - b.create_at || a.id.localeCompare(b.id))
    for (const post of staged) {
      const event = options.normalize(post, channel)
      if (event) {
        cursor.sequence = Math.max(cursor.sequence, after ?? 0) + 1
        if (!Number.isSafeInteger(cursor.sequence)) throw Error('Mattermost sequence exhausted')
        cursor.pending.push({ sequence: cursor.sequence, event })
      }
    }
    cursor.ready = cursor.pending.splice(100)
    scan.staged = []
    scan.floor = Math.max(scan.floor, scan.until)
    scan.until = Date.now()
    scan.page = 0
    scan.seen = Object.fromEntries(Object.entries(scan.seen).filter(([, at]) => at >= scan.floor))
    cursor.channel = (cursor.channel + 1) % channels.length
  } else {
    scan.page++
  }
  // No in-memory progress is kept if this atomic storage write fails.
  await storage.set(key, cursor)
  return cursor.pending
}

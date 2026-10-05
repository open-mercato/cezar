import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { getRunDrafts, putRunDraft } from '@/api/client'
import { queryKeys, useRunDrafts } from '@/api/queries'
import { DRAFT_TEXT_MAX, type RunDraftsResponse } from '@open-mercato/cezar-api-client'
import { COMMENT_MAX, describeLines, type DiffLineComment, type DiffLineEnd, type DiffNewLineComment } from '@/components/diff'
import { toast } from '@/components/ui/toaster'

/**
 * Diff line comments — the self-review flow. On the Changes tab the user leaves notes on lines of
 * the task's diff; they are NOT sent one by one. They pile up as draft items in the thread
 * composer (one chip per comment) and ride the next message to the agent as a single review.
 *
 * Stored in the run's server-side draft store under the `diff-comments` surface, as JSON in the
 * entry's `text`, so they survive the route change between Changes and the thread (the whole
 * point), a reload, and another browser. See `useDiffComments` for why they live in one shared
 * in-memory list per run (merged with the server's on every save) rather than in `useDraft`.
 */

export const DIFF_COMMENTS_SURFACE = 'diff-comments'

export interface DiffComment extends DiffLineComment {
  /** The commented line's text when the comment was written. */
  excerpt: string
  /** A removed line of a renamed file: the path its line number belongs to. */
  oldPath?: string
}

/** Defensive: the stored text is whatever the wire carried. Anything malformed is dropped. */
export function parseDiffComments(text: string): DiffComment[] {
  if (text === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: DiffComment[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    if (
      typeof c.id !== 'string' ||
      typeof c.path !== 'string' ||
      (c.side !== 'old' && c.side !== 'new') ||
      typeof c.line !== 'number' ||
      typeof c.body !== 'string'
    ) {
      continue
    }
    out.push({
      id: c.id,
      path: c.path,
      side: c.side,
      line: c.line,
      body: c.body,
      excerpt: typeof c.excerpt === 'string' ? c.excerpt : '',
      ...(typeof c.oldPath === 'string' && c.oldPath !== '' ? { oldPath: c.oldPath } : {}),
      ...(isLineEnd(c.start) ? { start: { side: c.start.side, line: c.start.line } } : {}),
    })
  }
  return out
}

function isLineEnd(value: unknown): value is DiffLineEnd {
  if (value === null || typeof value !== 'object') return false
  const end = value as Record<string, unknown>
  return (end.side === 'old' || end.side === 'new') && typeof end.line === 'number'
}

/** "line 12", "lines 10–14", "removed line 3 – line 5" — for the agent and for the chips. */
export function linesLabel(comment: Pick<DiffComment, 'side' | 'line' | 'start'>): string {
  return describeLines(comment, comment.start)
}

/** Path, then side (old-file numbers before new-file ones — they count different files), then
 *  line: the order a reviewer reads a diff in, whatever order the notes were left. */
export function sortDiffComments(comments: readonly DiffComment[]): DiffComment[] {
  const side = (c: DiffLineEnd) => (c.side === 'old' ? 0 : 1)
  // A range sorts by where it STARTS — that is where a reader meets it.
  const first = (c: DiffComment) => c.start ?? c
  return [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || side(first(a)) - side(first(b)) || first(a).line - first(b).line,
  )
}

/** The line that opens the review block — what `parseReviewMessage` finds it by. */
export const REVIEW_HEADING = 'Review comments on the diff:'

/**
 * What the agent receives: one review block, every comment anchored to file + line, its code in a
 * fenced block and the note as its own paragraph. The fence is what keeps the two apart: the old
 * `> quote` form let Markdown fold the note into the quote (a lazy continuation), so the agent and
 * the transcript both read the user's words as more of the code.
 */
export function formatDiffComments(comments: readonly DiffComment[]): string {
  if (comments.length === 0) return ''
  const blocks = sortDiffComments(comments).map((comment) => {
    // A removed line is numbered in the OLD file, so a renamed file names the old path with it.
    const where =
      comment.side === 'old' ?
        `\`${comment.oldPath ?? comment.path}\` line ${comment.line} (removed line${comment.oldPath ? `, renamed to \`${comment.path}\`` : ''})`
      : `\`${comment.path}\` line ${comment.line}`
    // ALWAYS fenced, even empty: a note that itself opens with a fence (a code suggestion) must
    // never be read back as the commented line.
    return `- ${comment.start ? rangeWhere(comment) : where}:\n\n${indent(fence(comment.excerpt))}\n\n${indent(comment.body)}`
  })
  return `${REVIEW_HEADING}\n\n${blocks.join('\n\n')}`
}

/** One comment of a review block, as read back out of a sent message. */
export interface ReviewItem {
  /** The file to open — the CURRENT path, also for a removed line of a renamed file. */
  path: string
  /** What the comment covers, as written: `line 12`, `lines 12–14`, `line 3 (removed line)`, … */
  label: string
  /** Where to jump: the first line it covers, and which side of the diff that number counts. */
  line?: number
  side: 'old' | 'new'
  excerpt: string
  body: string
}

const ITEM_HEADER = /^- `([^`]+)` (.+):$/

/**
 * Read a review block back out of a sent message, so the transcript can render it as comment
 * cards (file link · code · note) instead of one run of Markdown. Reads the current format and the
 * earlier `> quote` one, so already-sent reviews render too. Anything it does not recognise as a
 * review answers `undefined`, and the message renders as the plain Markdown it always was.
 */
export function parseReviewMessage(text: string): { lead: string; items: ReviewItem[] } | undefined {
  const at = text.indexOf(`${REVIEW_HEADING}\n\n`)
  // At the start of a line: after the typed message (blank line), or straight under a Send back's
  // `Review feedback:` line when no notes were typed.
  if (at === -1 || (at > 0 && text[at - 1] !== '\n')) return undefined
  const lead = text.slice(0, at).trim()
  const lines = text.slice(at + REVIEW_HEADING.length + 2).split('\n')
  const items: ReviewItem[] = []
  let index = 0
  while (index < lines.length) {
    const header = ITEM_HEADER.exec(lines[index] ?? '')
    if (!header) {
      if ((lines[index] ?? '').trim() === '') {
        index++
        continue
      }
      return undefined // not one of ours — leave the message alone
    }
    index++
    const content: string[] = []
    while (index < lines.length && !ITEM_HEADER.test(lines[index] ?? '')) {
      content.push((lines[index] ?? '').replace(/^ {2}/, ''))
      index++
    }
    items.push(readItem(header[1]!, header[2]!, content))
  }
  return items.length > 0 ? { lead, items } : undefined
}

function readItem(headerPath: string, label: string, content: string[]): ReviewItem {
  // A renamed file's removed line is headed by its OLD path; the diff lists the file by the new one.
  const renamed = /renamed to `([^`]+)`/.exec(label)?.[1]
  const first = /lines? (\d+)/.exec(label)
  // Old side when the label leads with it (`removed line 11 – line 14`) or notes it
  // (`line 3 (removed line)`). Two plain checks rather than one half-anchored regex.
  const side: 'old' | 'new' = label.startsWith('removed ') || label.includes('(removed line') ? 'old' : 'new'
  let rest = content
  while (rest[0]?.trim() === '') rest = rest.slice(1)
  let excerpt = ''
  const open = /^(`{3,})\s*$/.exec(rest[0] ?? '')
  if (open) {
    const close = rest.findIndex((line, i) => i > 0 && line.trim() === open[1])
    excerpt = rest.slice(1, close === -1 ? undefined : close).join('\n')
    rest = close === -1 ? [] : rest.slice(close + 1)
  } else {
    const quoted: string[] = []
    while (rest[0]?.startsWith('> ')) {
      quoted.push(rest[0].slice(2))
      rest = rest.slice(1)
    }
    excerpt = quoted.join('\n')
  }
  return {
    path: renamed ?? headerPath,
    label,
    ...(first ? { line: Number(first[1]) } : {}),
    side,
    excerpt,
    body: rest.join('\n').trim(),
  }
}

/**
 * The message that carries the comments: whatever the user typed, then the review. The typed text
 * leads because its first character is load-bearing — a `/skill` message is only expanded when it
 * STARTS with the slash (`expandRegistrySlashSkillText`), and so are the backends' own commands.
 */
export function withDiffComments(text: string, comments: readonly DiffComment[]): string {
  const review = formatDiffComments(comments)
  if (review === '') return text
  return text.trim() === '' ? review : `${text}\n\n${review}`
}

/** The command a message opens with (`/compact args` → `compact`), or undefined. The same token
 *  rule the server's registry expansion uses (`expandRegistrySlashSkillText`). */
export function slashCommandOf(text: string): string | undefined {
  return /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(text.trimStart())?.[1]
}

/**
 * May the comments ride this message? Not when it opens with a slash command cezar does not know
 * as a registry skill: that is a BACKEND command (`/compact`, `/clear`, …), and anything appended
 * becomes its arguments — the send succeeds, the comments are cleared, and the agent never saw a
 * review. A registry skill is fine: the server expands it and the review stays the request. While
 * the skill list is unknown, a slash message keeps its comments — losing them is the worse error.
 */
export function commentsRideWith(text: string, skillNames: readonly string[] | undefined): boolean {
  const command = slashCommandOf(text)
  return command === undefined || (skillNames?.includes(command) ?? false)
}

/** A range names its span; removed lines in it are numbered in the old file, so a renamed file
 *  says which one. */
function rangeWhere(comment: DiffComment): string {
  const touchesOld = comment.side === 'old' || comment.start?.side === 'old'
  const renamed = comment.oldPath && touchesOld ? ` (removed lines numbered in \`${comment.oldPath}\`)` : ''
  return `\`${comment.path}\` ${linesLabel(comment)}${renamed}`
}

/** The excerpt as a fenced code block — a range quotes all the code it covers. The fence is
 *  longer than any backtick run inside, so code that contains ``` cannot close it early. */
function fence(excerpt: string): string {
  const longest = Math.max(0, ...(excerpt.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  const code = trimBlankEdges(excerpt)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
  return `${ticks}\n${code}\n${ticks}`
}

function indent(body: string): string {
  return body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** How much of the commented line a comment keeps. A minified line can be the whole file, and
 *  every comment lives in ONE draft entry capped at `DRAFT_TEXT_MAX` — whose rejected write is
 *  silent by design — so an uncapped excerpt could quietly stop the comments from persisting. */
export const EXCERPT_MAX = 200

/** A range quotes every line it covers, so it gets more room — still bounded, for the same reason. */
export const RANGE_EXCERPT_MAX = 1000

export function capExcerpt(excerpt: string, max: number = EXCERPT_MAX): string {
  const trimmed = trimBlankEdges(excerpt)
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** Blank lines off both ends and trailing spaces off the last line — but every line's LEADING
 *  indentation kept, the first one's included: indentation is structure in Python or YAML, and a
 *  quoted block whose first line lost it reads as different code. */
export function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

/** What `POST /runs/:id/messages` and `POST /runs/:id/continue` accept (`messageInputSchema`,
 *  `continueSchema`): a message the review pushes past it would be refused with a schema error. */
export const MESSAGE_TEXT_MAX = 100_000

/** The send with the review attached, refused HERE with a reason the user can act on when it would
 *  be too long — the server's own refusal names a schema field. Throws, so the host keeps both the
 *  typed message and the comments (a failed send drops neither). */
export function messageWithReview(text: string, comments: readonly DiffComment[]): string {
  const message = withDiffComments(text, comments)
  if (message.length > MESSAGE_TEXT_MAX) {
    throw new Error(
      `Too long with the ${comments.length === 1 ? 'diff comment' : `${comments.length} diff comments`} attached — shorten the message or remove some comments.`,
    )
  }
  return message
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface DiffComments {
  /** The stored comments ARRIVED. Until then there is no list to add to: the first write would
   *  replace whatever the server holds with just the new comment. A FAILED read is not ready
   *  either, for the same reason — the server may still hold a list this cockpit never saw.
   *  Hosts offer "add" only once ready. */
  ready: boolean
  comments: DiffComment[]
  /** `false` when the comment could not be kept (the list would outgrow the draft cap). */
  add: (comment: DiffNewLineComment) => boolean
  update: (id: string, body: string) => boolean
  remove: (id: string) => void
  clear: () => void
  /** Hand the comments to a send. Once it lands, exactly the comments it carried are dropped —
   *  one added, or edited, while it was in flight stays a draft. A failed send keeps them all. */
  submit: <T>(action: (comments: DiffComment[]) => Promise<T>) => Promise<T>
}

/**
 * The comments live in ONE place per run: an in-memory list every host subscribes to, seeded once
 * from the server's draft listing and changed only by the user's own actions. Unlike the text
 * inputs (`useDraft`, which seeds local state once and then owns it), no host keeps a copy — the
 * Changes tab, the Session composer and the review panel can each be the one that adds, sends or
 * clears, and a tab switched to mid-send must see the send's outcome, not the list as it was when
 * the tab mounted.
 *
 * Deliberately NOT read live from the query cache: a send invalidates the run's queries, and a
 * refetch answered before the clearing write landed would put the sent comments straight back.
 * Each write still mirrors into the cache, so a fresh load reads what was written. Keyed by the
 * query client, so every client (and every test) has its own lists.
 *
 * Every save is a THREE-WAY merge against the server's list: another window (or browser) on the
 * same task keeps a list of its own. `base` is the server list as this window last read or wrote
 * it, so a save can tell "the other window removed or sent this" (in `base`, gone from the server
 * — drop it) from "this window added it" (local, not in `base` — keep it). Comments this window
 * removed or sent are remembered (`removed`), so a merge never brings them back either. A fresh
 * listing (window focus, any refetch) is merged into the live list whenever no save is in flight,
 * so a chip the other window already sent disappears here too. Two windows editing the SAME
 * comment: an edit made here wins; otherwise the server's version is taken.
 */
interface CommentsStore {
  lists: Map<string, DiffComment[]>
  listeners: Map<string, Set<() => void>>
  /** One write chain per run: two quick edits on two tabs still land in order. */
  chains: Map<string, Promise<unknown>>
  /** Per run: ids this window removed or sent — never merged back in from the server. */
  removed: Map<string, Set<string>>
  /** Per run: the server's list as this window last read or wrote it — the merge's common base. */
  base: Map<string, DiffComment[]>
  /** Per run: saves queued or in flight. A listing that arrives meanwhile is left to them. */
  pending: Map<string, number>
}
const stores = new WeakMap<object, CommentsStore>()
function storeFor(client: object): CommentsStore {
  let store = stores.get(client)
  if (!store) {
    store = { lists: new Map(), listeners: new Map(), chains: new Map(), removed: new Map(), base: new Map(), pending: new Map() }
    stores.set(client, store)
  }
  return store
}

const NO_COMMENTS: DiffComment[] = []

export function useDiffComments(runId: string): DiffComments {
  const queryClient = useQueryClient()
  const store = storeFor(queryClient)
  const drafts = useRunDrafts(runId === '' ? undefined : runId)
  const storedText = drafts.data?.surfaces?.[DIFF_COMMENTS_SURFACE]?.text
  const serverComments = useMemo(
    () => parseDiffComments(typeof storedText === 'string' ? storedText : ''),
    [storedText],
  )

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

  // Seed from the first listing that arrives; after that, MERGE every newer listing into the live
  // list (three-way, against `base`) — unless a save is queued or in flight, which does its own
  // merge against a fresher read. Removals and sends made in another window land here this way.
  useEffect(() => {
    if (!drafts.isSuccess) return
    const local = store.lists.get(runId)
    if (local === undefined) {
      store.lists.set(runId, serverComments)
      store.base.set(runId, serverComments)
      store.listeners.get(runId)?.forEach((listener) => listener())
      return
    }
    if ((store.pending.get(runId) ?? 0) > 0) return
    const merged = mergeComments(local, serverComments, store.base.get(runId) ?? [], store.removed.get(runId))
    store.base.set(runId, serverComments)
    if (merged !== local) {
      store.lists.set(runId, merged)
      store.listeners.get(runId)?.forEach((listener) => listener())
    }
  }, [drafts.isSuccess, runId, serverComments, store])

  // Coming back to this window re-reads the listing, so what another window sent or removed
  // meanwhile is merged in (above) before the user acts on a stale chip.
  useEffect(() => {
    if (runId === '') return
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs.drafts(runId) })
      }
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [queryClient, runId])

  const comments = live ?? (drafts.isSuccess ? serverComments : NO_COMMENTS)

  /** The list as it stands NOW — never a render's snapshot, which a send outlives. */
  const current = useCallback(
    (): DiffComment[] => store.lists.get(runId) ?? serverComments,
    [runId, serverComments, store],
  )

  /** Put `next` in the store, tell every host, and mirror it into the cached listing (so a later
   *  mount, or a reload's first read, agrees). */
  const publish = useCallback(
    (next: DiffComment[]) => {
      store.lists.set(runId, next)
      store.listeners.get(runId)?.forEach((listener) => listener())
      const text = serialize(next)
      queryClient.setQueryData<RunDraftsResponse>(queryKeys.runs.drafts(runId), (listing) => {
        const surfaces = { ...(listing?.surfaces ?? {}) }
        if (text === '') delete surfaces[DIFF_COMMENTS_SURFACE]
        else surfaces[DIFF_COMMENTS_SURFACE] = { text, images: [], updatedAt: new Date().toISOString() }
        return { surfaces }
      })
    },
    [queryClient, runId, store],
  )

  /** Every write is size-checked HERE: the store refuses an over-cap entry, and a refused draft
   *  write is silent by design — so the comments would look kept and be gone after a reload.
   *  `dropped` are the ids this change removes, remembered so no later merge restores them. */
  const write = useCallback(
    (next: DiffComment[], dropped: readonly string[] = []): boolean => {
      if (serialize(next).length > DRAFT_TEXT_MAX) {
        toast('Too many comments to keep as a draft — send the ones you have first.', { tone: 'danger' })
        return false
      }
      if (dropped.length > 0) {
        const removed = store.removed.get(runId) ?? new Set<string>()
        for (const id of dropped) removed.add(id)
        store.removed.set(runId, removed)
      }
      publish(next)
      // In order, and silent on failure, like every draft write — it must never be louder than
      // the review it carries. Each step saves the list as it stands WHEN IT RUNS, three-way merged
      // with the server's, so a burst of edits coalesces and nothing another window saved — or
      // removed — is undone.
      store.pending.set(runId, (store.pending.get(runId) ?? 0) + 1)
      const chained = (store.chains.get(runId) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const local = store.lists.get(runId) ?? next
          let merged = local
          try {
            const listing = await getRunDrafts(runId)
            const text = listing.surfaces?.[DIFF_COMMENTS_SURFACE]?.text
            const server = parseDiffComments(typeof text === 'string' ? text : '')
            merged = mergeComments(local, server, store.base.get(runId) ?? [], store.removed.get(runId))
          } catch {
            // Unreadable: save what this window has — no worse than before the merge existed.
          }
          if (merged !== local) publish(merged)
          const text = serialize(merged)
          if (text.length > DRAFT_TEXT_MAX) return // the other window's comments pushed it over; keep what's stored
          await putRunDraft(runId, DIFF_COMMENTS_SURFACE, { text, images: [] })
          store.base.set(runId, merged)
        })
        .catch(() => {})
        .finally(() => {
          store.pending.set(runId, Math.max(0, (store.pending.get(runId) ?? 1) - 1))
        })
      store.chains.set(runId, chained)
      return true
    },
    [publish, runId, store],
  )

  const add = useCallback(
    (comment: DiffNewLineComment) =>
      write([
        ...current(),
        {
          ...comment,
          body: comment.body.slice(0, COMMENT_MAX),
          excerpt: capExcerpt(comment.excerpt, comment.start ? RANGE_EXCERPT_MAX : EXCERPT_MAX),
          id: newId(),
        },
      ]),
    [current, write],
  )
  const update = useCallback(
    (id: string, body: string) =>
      write(current().map((c) => (c.id === id ? { ...c, body: body.slice(0, COMMENT_MAX) } : c))),
    [current, write],
  )
  const remove = useCallback(
    (id: string) => void write(current().filter((c) => c.id !== id), [id]),
    [current, write],
  )
  const clear = useCallback(
    () => void write([], current().map((c) => c.id)),
    [current, write],
  )

  // Not cleared up front (unlike the composer's optimistic clear): a rejected send must leave
  // every comment exactly where it was, and the chips staying put during the send says so.
  const submit = useCallback(
    async <T>(action: (held: DiffComment[]) => Promise<T>): Promise<T> => {
      const held = current()
      const result = await action(held)
      if (held.length > 0) {
        // Drop what was SENT, as it was sent: a comment added meanwhile, or edited after it was
        // captured, is not what the agent read — it stays a draft for the next message.
        const sent = new Map(held.map((c) => [c.id, c.body]))
        const now = current()
        write(
          now.filter((c) => sent.get(c.id) !== c.body),
          now.filter((c) => sent.get(c.id) === c.body).map((c) => c.id),
        )
      }
      return result
    },
    [current, write],
  )

  // Ready once the list has loaded ONCE: a later background refetch that fails (every send
  // invalidates the run's queries) turns `isSuccess` false while the list is long since in hand,
  // and must not take the "+" away.
  return { ready: live !== undefined || drafts.isSuccess, comments, add, update, remove, clear, submit }
}

function serialize(comments: readonly DiffComment[]): string {
  return comments.length === 0 ? '' : JSON.stringify(comments)
}

/**
 * Three-way merge of this window's list (`local`) with the server's (`server`), against the list
 * both last agreed on (`base`):
 * - a comment in `base` that is gone from the server was removed or sent ELSEWHERE — dropped;
 * - a comment only in `local` was added here — kept;
 * - a comment only on the server was added elsewhere — taken, unless this window removed it;
 * - a comment in both: this window's version when it edited it (its body differs from `base`),
 *   else the server's (another window's edit).
 * Returns `local` itself when nothing changes, so callers can tell a no-op merge.
 */
export function mergeComments(
  local: readonly DiffComment[],
  server: readonly DiffComment[],
  base: readonly DiffComment[],
  removed: ReadonlySet<string> | undefined,
): DiffComment[] {
  const baseById = new Map(base.map((c) => [c.id, c]))
  const serverById = new Map(server.map((c) => [c.id, c]))
  const out: DiffComment[] = []
  for (const comment of local) {
    const atBase = baseById.get(comment.id)
    const onServer = serverById.get(comment.id)
    if (atBase && !onServer) continue // removed or sent in another window
    const editedHere = !atBase || atBase.body !== comment.body
    out.push(onServer && !editedHere ? onServer : comment)
  }
  const known = new Set(local.map((c) => c.id))
  for (const comment of server) {
    if (!known.has(comment.id) && !removed?.has(comment.id)) out.push(comment)
  }
  const same =
    out.length === local.length && out.every((c, i) => c === local[i] || JSON.stringify(c) === JSON.stringify(local[i]))
  return same ? (local as DiffComment[]) : out
}

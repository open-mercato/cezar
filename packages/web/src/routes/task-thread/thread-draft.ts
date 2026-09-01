import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { deleteRunDraftImage, getRunDraftImage, postRunDraftImage, putRunDraft } from '@/api/client'
import { queryKeys, useRunDrafts } from '@/api/queries'
import type { DraftImage, RunDraftsResponse } from '@open-mercato/cezar-api-client'
import {
  MAX_IMAGES,
  type ImagesChangeReason,
  type PendingImage,
} from '@/components/composer/composer-images'

/**
 * `useDraft(runId, surface)` — the cockpit's ONE entry point to the in-task draft store (#939,
 * spec `.ai/specs/2026-08-30-thread-composer-draft-persistence.md`).
 *
 * The problem it solves is the product's core loop: this is a parallel-agent cockpit, so checking
 * on another task mid-sentence is not an edge case, and until this existed a route change unmounted
 * the composer and threw away whatever was in it. Every editable input INSIDE a task now keeps its
 * unsent content on the server, keyed by `(runId, surface)`, and gets it back on return.
 *
 * The discipline, in the order it matters:
 *
 * 1. **Local state is authoritative while the input is mounted.** The server answer seeds it once,
 *    and only while the input is still pristine — if the fetch is slow and the user has already
 *    started typing, what they typed wins. Nothing re-reads the server afterwards (`useRunDrafts`
 *    is `staleTime: Infinity` with no focus refetch), because a background refetch landing
 *    mid-sentence would overwrite live text.
 * 2. **Writes are debounced, serialized and optimistic.** One `PUT` per typing pause, chained so
 *    two rapid edits can never land out of order, and the query cache is updated at edit time
 *    rather than on the response — so a remount within the session restores what the user typed
 *    even if the server never accepted it (a read-only repo, a full disk). A failed draft write is
 *    SILENT: it must never be louder than the message being written.
 * 3. **Sending clears; failing to send does not.** `submit()` wraps the host's real action: the
 *    composer's optimistic clear is held back until the send resolves, so a rejected message is
 *    restored into a draft that still has its attachments.
 * 4. **The pending write is flushed on unmount and on `visibilitychange → hidden`** (the latter
 *    with `keepalive`), so closing the tab mid-sentence still persists.
 *
 * Attachments upload when they are ATTACHED, not when the message is sent, so the bytes cross the
 * wire once and the draft record only references them.
 */

/** One typing pause. Long enough that a fast typist writes once per sentence, short enough that
 *  "I closed the tab a moment later" still persisted. */
export const DRAFT_WRITE_DEBOUNCE_MS = 500

export interface Draft {
  /** The seed has settled — the server answered (or failed to). Hosts that decide whether to
   *  OPEN an editor wait for this; hosts that only need a value do not. */
  ready: boolean
  /** There is stored, unsent content for this surface. What re-opens an inline editor on return. */
  hasDraft: boolean
  text: string
  setText: (next: string) => void
  images: PendingImage[]
  /** `reason` is the composer's own word for the change — see `ImagesChangeReason`. A host that
   *  is not the composer omits it and gets the ordinary "the user edited this" handling. */
  setImages: (next: PendingImage[], reason?: ImagesChangeReason) => void
  /**
   * Run the host's real send with the draft held open. On success the draft (and its blobs) are
   * dropped; on failure the pending write resumes, so the restore the composer performs is
   * persisted rather than lost.
   */
  submit: <T>(action: () => Promise<T>) => Promise<T>
  /** Drop this surface's draft now — an explicit Cancel, or a host that finished another way. */
  clear: () => void
}

/** Metadata for the query cache: what the server would answer for the images we hold. */
function draftImages(images: readonly PendingImage[]): DraftImage[] {
  const out: DraftImage[] = []
  for (const image of images) {
    if (image.id === undefined) continue
    out.push({ id: image.id, mediaType: image.mediaType, name: image.name, bytes: 0 })
  }
  return out
}

export interface DraftOptions {
  /**
   * Off makes the whole hook inert — no read, no write, local state only.
   *
   * For the rows that render one per queued message: hooks cannot be called in a loop that
   * changes length, so the host passes every bubble a surface and the ones with nothing to draft
   * (a historical message, a run that is no longer queued) simply switch theirs off.
   */
  enabled?: boolean
}

export function useDraft(runId: string, surface: string, { enabled = true }: DraftOptions = {}): Draft {
  const queryClient = useQueryClient()
  const live = enabled && runId !== '' && surface !== ''
  const drafts = useRunDrafts(live ? runId : undefined)
  // Optional at both levels on purpose: `data` is whatever came back over the wire, and a body
  // that is not a draft listing must leave the thread working with an empty composer.
  const entry = drafts.data?.surfaces?.[surface]

  const [text, setTextState] = useState('')
  const [images, setImagesState] = useState<PendingImage[]>([])

  // Per-(run, surface) identity. Item ids and surface names repeat across runs, so everything
  // below is reset the moment either changes — a draft must never leak into another task's box.
  const key = `${runId} ${surface}`
  const [renderedKey, setRenderedKey] = useState(key)
  const dirty = useRef(false)
  const seeded = useRef<string | undefined>(undefined)
  const sending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  // The identity here is the one the CURRENT text belongs to, and it is adopted at the key swap
  // below rather than on every render: during the render that swaps surfaces, `runId`/`surface`
  // are already the NEW ones while `text` is still the outgoing draft's — reading both from the
  // props would file the old text under the new task.
  const latest = useRef({ runId, surface, text, images })
  latest.current.text = text
  latest.current.images = images

  // A pending write whose surface went away before its debounce fired. The thread does NOT
  // unmount when the route's `:id` changes — React keeps the component and swaps the prop — so
  // without this, walking from task A to task B mid-sentence would silently drop A's last edit,
  // which is the very move this feature exists to survive.
  const orphaned = useRef<Array<{ runId: string; surface: string; text: string; images: string[] }>>([])

  // Adjusted DURING render rather than in an effect: an effect would let one frame paint the
  // previous task's text into this task's composer, which is the exact bug this keying exists to
  // prevent (React's own "adjusting state when a prop changes" pattern).
  if (renderedKey !== key) {
    setRenderedKey(key)
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
      const leaving = latest.current
      // Replace rather than append: a double-invoked render must not queue the same write twice.
      orphaned.current = [
        ...orphaned.current.filter((o) => o.runId !== leaving.runId || o.surface !== leaving.surface),
        {
          runId: leaving.runId,
          surface: leaving.surface,
          text: leaving.text,
          images: leaving.images.map((i) => i.id).filter((id): id is string => id !== undefined),
        },
      ]
    }
    setTextState('')
    setImagesState([])
    dirty.current = false
    sending.current = false
    latest.current = { runId, surface, text: '', images: [] }
  }

  /** Patch the cached draft listing so a remount in this session restores what was typed, even
   *  if the server write failed. */
  const cache = useCallback(
    (forRunId: string, forSurface: string, next: { text: string; images: DraftImage[] } | null) => {
      queryClient.setQueryData<RunDraftsResponse>(queryKeys.runs.drafts(forRunId), (current) => {
        const surfaces = { ...(current?.surfaces ?? {}) }
        if (next === null || (next.text === '' && next.images.length === 0)) delete surfaces[forSurface]
        else surfaces[forSurface] = { ...next, updatedAt: new Date().toISOString() }
        return { surfaces }
      })
    },
    [queryClient],
  )
  // `write` is stable by design (it is what the unmount flush closes over), so it reaches `cache`
  // through a ref rather than a dependency.
  const cacheRef = useRef(cache)
  cacheRef.current = cache

  /** Send one write, chained behind whatever is already in flight for this surface. Failures are
   *  swallowed on purpose — see the header note. */
  const liveRef = useRef(live)
  liveRef.current = live
  const write = useCallback(
    (forRunId: string, forSurface: string, body: { text: string; images: string[] }, keepalive?: boolean) => {
      if (!liveRef.current) return
      chain.current = chain.current
        .catch(() => {})
        .then(() => putRunDraft(forRunId, forSurface, body, keepalive ? { keepalive: true } : undefined))
        // The accepted write is the newest thing anyone knows about this surface, so it wins in
        // the cache. Without this, a `GET` that was already in flight when the user started
        // typing could land afterwards and leave the cache holding the PREVIOUS draft — which a
        // remount later in the session would then seed, resurrecting text the user replaced.
        .then((written) => cacheRef.current(forRunId, forSurface, written))
        .catch(() => {})
    },
    [],
  )

  const cancelPending = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  /** Write what the input holds right now. */
  const flush = useCallback(
    (keepalive?: boolean) => {
      cancelPending()
      const current = latest.current
      write(
        current.runId,
        current.surface,
        {
          text: current.text,
          images: current.images.map((image) => image.id).filter((id): id is string => id !== undefined),
        },
        keepalive,
      )
    },
    [cancelPending, write],
  )

  const schedule = useCallback(() => {
    cancelPending()
    timer.current = setTimeout(() => {
      timer.current = null
      // A send is in flight: the composer has already optimistically cleared, and whether that
      // clear is real depends on whether the message lands. `submit` writes the outcome.
      if (sending.current) return
      flush()
    }, DRAFT_WRITE_DEBOUNCE_MS)
  }, [cancelPending, flush])

  /** Local edit → optimistic cache → debounced write. */
  const record = useCallback(
    (nextText: string, nextImages: readonly PendingImage[]) => {
      dirty.current = true
      if (!liveRef.current) return
      cache(runId, surface, { text: nextText, images: draftImages(nextImages) })
      schedule()
    },
    [cache, runId, schedule, surface],
  )

  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      latest.current = { ...latest.current, text: next }
      record(next, latest.current.images)
    },
    [record],
  )

  const setImages = useCallback(
    (next: PendingImage[], reason: ImagesChangeReason = 'edit') => {
      const dropped = latest.current.images
        .map((held) => held.id)
        .filter((id): id is string => id !== undefined && !next.some((kept) => kept.id === id))
      setImagesState(next)
      latest.current = { ...latest.current, images: next }
      record(latest.current.text, next)
      // The composer TELLS us which emptying this is (`composer-images.ts`): a send's optimistic
      // clear must leave the blobs alone until it resolves — a rejected message is restored with
      // its attachments, and a landed one drops them through the empty write in `clear()`. Only a
      // thumbnail the user actually removed is deleted here.
      if (reason !== 'submit' && liveRef.current) {
        for (const id of dropped) {
          void deleteRunDraftImage(runId, surface, id).catch(() => {})
        }
      }
      // Anything without an id is new: upload it once, then re-file it in place so the next write
      // can name it. Matched by object identity — the composer only ever filters and spreads the
      // array, so the entries themselves survive.
      const forRunId = runId
      const forSurface = surface
      for (const image of next) {
        if (image.id !== undefined || !liveRef.current) continue
        void postRunDraftImage(forRunId, forSurface, {
          mediaType: image.mediaType,
          data: image.data,
          name: image.name,
        })
          .then((stored) => {
            if (latest.current.runId !== forRunId || latest.current.surface !== forSurface) return
            setImagesState((current) => {
              const updated = current.map((held) => (held === image ? { ...held, id: stored.id } : held))
              latest.current = { ...latest.current, images: updated }
              return updated
            })
            record(latest.current.text, latest.current.images)
          })
          // An attachment that could not be stored still rides the message the user sends; it
          // just will not come back after a reload. Silent, like every other draft write.
          .catch(() => {})
      }
    },
    [record, runId, surface],
  )

  const clear = useCallback(() => {
    cancelPending()
    sending.current = false
    setTextState('')
    setImagesState([])
    latest.current = { ...latest.current, text: '', images: [] }
    dirty.current = false
    cache(runId, surface, null)
    // An empty PUT is the delete — one path for "the user emptied it" and "the message went",
    // and the store drops the surface's blobs with it.
    write(runId, surface, { text: '', images: [] })
  }, [cache, cancelPending, runId, surface, write])

  const submit = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      sending.current = true
      cancelPending()
      try {
        const result = await action()
        sending.current = false
        clear()
        return result
      } catch (error) {
        sending.current = false
        // Scheduled rather than flushed: the host restores the message AFTER this rejection
        // propagates (the composer's own `restoreOnError`), so writing right here would persist
        // the optimistic clear and only correct it a beat later. One debounce lets the restore
        // land first, and the draft is written once, holding what the input actually shows.
        schedule()
        throw error
      }
    },
    [cancelPending, clear, schedule],
  )

  // Drain whatever the surface swap left behind, once the render that queued it has committed.
  useEffect(() => {
    if (orphaned.current.length === 0) return
    const queued = orphaned.current
    orphaned.current = []
    for (const item of queued) write(item.runId, item.surface, { text: item.text, images: item.images })
  })

  // ---- seeding -------------------------------------------------------------------------------

  useEffect(() => {
    if (seeded.current === key || entry === undefined) return
    seeded.current = key
    if (dirty.current) return // the user got here first; never fight them
    // Read defensively: `entry` is whatever the wire carried. A body that is not a draft entry
    // must leave the input empty and working, never take the thread down with it.
    const seedText = typeof entry.text === 'string' ? entry.text : ''
    const seedImages = Array.isArray(entry.images) ? entry.images : []
    setTextState(seedText)
    latest.current = { ...latest.current, text: seedText }
    if (seedImages.length === 0) return
    let live = true
    void Promise.all(
      seedImages.slice(0, MAX_IMAGES).map(async (image): Promise<PendingImage | null> => {
        try {
          const blob = await getRunDraftImage(runId, surface, image.id)
          return {
            id: blob.id,
            mediaType: blob.mediaType,
            data: blob.data,
            name: blob.name,
            preview: `data:${blob.mediaType};base64,${blob.data}`,
          }
        } catch {
          return null // a blob that is gone simply does not come back
        }
      }),
    ).then((restored) => {
      const kept = restored.filter((image): image is PendingImage => image !== null)
      if (!live || kept.length === 0 || dirty.current) return
      setImagesState(kept)
      latest.current = { ...latest.current, images: kept }
    })
    return () => {
      live = false
    }
  }, [entry, key, runId, surface])

  // ---- flushes -------------------------------------------------------------------------------

  useEffect(() => {
    const leaving = () => {
      if (timer.current === null || sending.current) return
      flush(true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') leaving()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // `pagehide` as well as the visibility flip: a full navigation (a typed URL, a reload, the
    // back button out of the app) tears the document down WITHOUT running React's unmount
    // effects, and it is the last event that can still dispatch a `keepalive` write.
    window.addEventListener('pagehide', leaving)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', leaving)
    }
  }, [flush])

  // Unmount (a route change, the whole point of the feature) flushes immediately. Keyed on
  // nothing, so it runs once, at teardown, against the refs' latest values.
  useEffect(
    () => () => {
      if (timer.current === null) return
      flush()
    },
    [flush],
  )

  return {
    ready: !live || drafts.isSuccess || drafts.isError,
    hasDraft: text !== '' || images.length > 0,
    text,
    setText,
    images,
    setImages,
    submit,
    clear,
  }
}

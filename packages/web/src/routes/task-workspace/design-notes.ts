import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import {
  ApiError,
  continueRun,
  editQueuedRunPrompt,
  putRunDraft,
  queueRunPrompt,
  removeQueuedRunPrompt,
  sendMessage,
} from '@/api/client'
import { useRunDrafts } from '@/api/queries'
import { DRAFT_TEXT_MAX, type ApiRun } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

import {
  DESIGN_PICKS_SURFACE,
  messageWithDesignPicks,
  parseDesignPick,
  pickLabel,
  type NewDesignPick,
} from '../task-thread/design-picks'

/**
 * Design Mode notes (spec `.ai/specs/2026-10-09-design-mode.md` §7): one element of the task's
 * app, and what the user wants changed about it.
 *
 * A note has two lives, kept in two places on purpose:
 *
 *  - a DRAFT — the element is framed, the text is being written. Persisted in the run's draft
 *    store (the `design-picks` surface), so a half-written note survives a reload of the page,
 *    of the cockpit, and a layout switch. Several drafts can be open at once.
 *  - SENT — the prompt went to the agent, or is waiting in the session's prompt queue. Kept in
 *    memory only, numbered in the order sent: it is a receipt for this review, and the page it
 *    marks is gone after a reload anyway. The WORK is not lost with it — a queued prompt lives on
 *    the run record and runs whether or not anyone is looking.
 *
 * A sent note's status is not stored, it is READ off the run: still listed in `promptQueue` →
 * waiting its turn; delivered and the run working → in progress; the run came to rest → done,
 * or the agent is asking something.
 */

/** A note's element, plus the page's handle on it (`mark`) — always present here. */
export type NotePick = NewDesignPick & { mark: string }

export type NotePhase = 'draft' | 'queued' | 'running' | 'asking' | 'done'

export interface DesignNote {
  /** The picker's key for the element. The note's identity everywhere. */
  key: string
  pick: NotePick
  text: string
  phase: NotePhase
  /** The order it was sent in. Absent on a draft. */
  number?: number
  /** Its entry in the run's prompt queue, while it has one. */
  queueId?: string
}

interface SentNote extends DesignNote {
  number: number
  /** The run has been seen working since this note was delivered — see `advance`. */
  sawRunning: boolean
  deliveredAt?: number
  /** Its queue entry has been seen on the run record, and when it was queued — see `advance`. */
  seenQueued?: boolean
  queuedAt?: number
}

interface DraftNote {
  key: string
  pick: NotePick
  text: string
}

/** What the Browser column tells the page to frame. */
export interface DesignMark {
  key: string
  /** A sent note's number; absent on a draft, whose frame is plain. */
  n?: number
  /** Drafts only: how the page finds the element again after a reload. */
  selector?: string
  path?: string
  label: string
  draft: boolean
}

export const NOTE_TEXT_MAX = 20_000
export const DRAFT_NOTES_MAX = 12

interface NotesStore {
  /** `undefined` until the stored drafts arrived — before that an add would overwrite them. */
  drafts: DraftNote[] | undefined
  sent: SentNote[]
  counter: number
  listeners: Set<() => void>
  chain: Promise<unknown>
  timer: ReturnType<typeof setTimeout> | undefined
  version: number
}
const stores = new Map<string, NotesStore>()
function storeFor(runId: string): NotesStore {
  let store = stores.get(runId)
  if (!store) {
    store = { drafts: undefined, sent: [], counter: 0, listeners: new Set(), chain: Promise.resolve(), timer: undefined, version: 0 }
    stores.set(runId, store)
  }
  return store
}

/** Test seam: every run's notes, forgotten. */
export function resetDesignNotes(): void {
  for (const store of stores.values()) clearTimeout(store.timer)
  stores.clear()
}

export function parseDraftNotes(text: string): DraftNote[] {
  if (text === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: DraftNote[] = []
  for (const item of raw.slice(0, DRAFT_NOTES_MAX) as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const pick = parseDesignPick(record.pick)
    if (!pick || pick.mark === undefined) continue
    out.push({
      key: pick.mark,
      pick: { ...pick, mark: pick.mark },
      text: typeof record.text === 'string' ? record.text.slice(0, NOTE_TEXT_MAX) : '',
    })
  }
  return out
}

const serialize = (drafts: readonly DraftNote[]): string =>
  drafts.length === 0 ? '' : JSON.stringify(drafts.map((draft) => ({ pick: draft.pick, text: draft.text })))

const pathOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

/** The prompt the agent receives for a note: the user's words, then the element. */
export function noteMessage(note: Pick<DesignNote, 'key' | 'pick' | 'text'>): string {
  return messageWithDesignPicks(note.text.trim(), [{ ...note.pick, id: note.key }])
}

/**
 * Move the sent notes along with the run. Pure, so the lifecycle is testable without a session.
 *
 * Both transitions wait for evidence rather than for an absence, because this window's copy of the
 * run always lags the request that changed it.
 *
 * `sawRunning` is what keeps a note from being called done the instant it is delivered: the send
 * returns before the run record this window holds has caught up, so for a moment the note is
 * "delivered" while the run still reads `waiting`. A note finishes only after the run has been
 * SEEN working since — or, for a turn too short to ever be seen, after a grace period.
 */
export function advance(
  sent: readonly SentNote[],
  run: { status: ApiRun['status']; queueIds: ReadonlySet<string>; asking: boolean },
  now: number,
): SentNote[] {
  const working = run.status === 'running'
  let changed = false
  let next = sent.map((note) => {
    let out = note
    if (out.phase === 'queued' && out.queueId !== undefined) {
      if (run.queueIds.has(out.queueId)) {
        if (!out.seenQueued) out = { ...out, seenQueued: true }
      } else if (out.seenQueued || now - (out.queuedAt ?? now) > DELIVERY_GRACE_MS) {
        // Left the queue without being withdrawn here: it was delivered. "Left" needs it to have
        // BEEN there — the same lag as below, in the other direction: the queue request returns
        // before this window's run record lists the new entry.
        out = { ...out, phase: 'running', queueId: undefined, sawRunning: working, deliveredAt: now }
      }
    }
    if (out.phase === 'asking' && working) out = { ...out, phase: 'running', sawRunning: true }
    if (out.phase === 'running') {
      if (working) {
        if (!out.sawRunning) out = { ...out, sawRunning: true }
      } else if (out.sawRunning || now - (out.deliveredAt ?? now) > DELIVERY_GRACE_MS) {
        out = { ...out, phase: run.asking ? 'asking' : 'done' }
      }
    }
    if (out !== note) changed = true
    return out
  })
  // One session, one turn at a time: only the note delivered last can still be in progress.
  const active = next.filter((note) => note.phase === 'running' || note.phase === 'asking')
  if (active.length > 1) {
    const latest = active.reduce((a, b) => ((b.deliveredAt ?? 0) >= (a.deliveredAt ?? 0) ? b : a))
    next = next.map((note) => (active.includes(note) && note !== latest ? { ...note, phase: 'done' as const } : note))
    changed = true
  }
  return changed ? next : (sent as SentNote[])
}

const DELIVERY_GRACE_MS = 15_000

export interface DesignNotes {
  /** Drafts first (in the order picked), then sent notes (in the order sent). */
  notes: DesignNote[]
  marks: DesignMark[]
  note: (key: string) => DesignNote | undefined
  /** A new draft for a freshly picked element. `false` (with a toast) when it was not kept. */
  addDraft: (pick: NewDesignPick) => boolean
  setText: (key: string, text: string) => void
  /** Throw a draft away — the element is deselected. */
  discard: (key: string) => void
  /** Send a draft to the agent. Resolves once it is delivered or queued; rejects with the
   *  reason, leaving the draft exactly as it was. */
  send: (key: string) => Promise<void>
  /** Reword a note that is still waiting in the queue. */
  saveQueued: (key: string, text: string) => Promise<void>
  /** Take a waiting note back out of the queue. */
  withdraw: (key: string) => Promise<void>
}

export function useDesignNotes(run: ApiRun): DesignNotes {
  const runId = run.id
  const store = storeFor(runId)
  const drafts = useRunDrafts(runId)
  const storedText = drafts.data?.surfaces?.[DESIGN_PICKS_SURFACE]?.text

  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    },
    [store],
  )
  useSyncExternalStore(subscribe, () => store.version)
  const publish = useCallback(() => {
    store.version++
    store.listeners.forEach((listener) => listener())
  }, [store])

  // Seeded from the FIRST listing only; from then on this window's list is the truth and every
  // change is written through.
  useEffect(() => {
    if (!drafts.isSuccess || store.drafts !== undefined) return
    store.drafts = parseDraftNotes(typeof storedText === 'string' ? storedText : '')
    publish()
  }, [drafts.isSuccess, publish, store, storedText])

  /** Save the drafts as they stand when the write runs — a burst of keystrokes is one write. */
  const persist = useCallback(
    (delayMs: number) => {
      clearTimeout(store.timer)
      store.timer = setTimeout(() => {
        const text = serialize(store.drafts ?? [])
        // Refused silently by the server above the cap, so it is not sent: what is stored stays.
        if (text.length > DRAFT_TEXT_MAX) return
        store.chain = store.chain.catch(() => {}).then(() => putRunDraft(runId, DESIGN_PICKS_SURFACE, { text, images: [] })).catch(() => {})
      }, delayMs)
    },
    [runId, store],
  )

  // The latest run, for the async actions below: a send outlives the render that started it.
  const runRef = useRef(run)
  runRef.current = run

  // Sent notes follow the run.
  const queueKey = (run.promptQueue ?? []).map((entry) => entry.id).join(' ')
  // Not in the contract's run type, but on the wire: the engine's own "this park is a question".
  const asking = run.status === 'waiting' && (run as { askParked?: unknown }).askParked === true
  useEffect(() => {
    const next = advance(store.sent, { status: run.status, queueIds: new Set(queueKey === '' ? [] : queueKey.split(' ')), asking }, Date.now())
    if (next !== store.sent) {
      store.sent = next
      publish()
    }
  }, [asking, publish, queueKey, run.status, store, store.version])

  const addDraft = useCallback(
    (pick: NewDesignPick): boolean => {
      if (store.drafts === undefined) {
        toast('Still loading this task — click the element again in a moment.')
        return false
      }
      if (pick.mark === undefined) return false
      if (store.drafts.length >= DRAFT_NOTES_MAX) {
        toast(`${DRAFT_NOTES_MAX} notes are already open — send or close some first.`, { tone: 'danger' })
        return false
      }
      store.drafts = [...store.drafts, { key: pick.mark, pick: { ...pick, mark: pick.mark }, text: '' }]
      publish()
      persist(0)
      return true
    },
    [persist, publish, store],
  )

  const setText = useCallback(
    (key: string, text: string) => {
      if (!store.drafts?.some((draft) => draft.key === key)) return
      store.drafts = store.drafts.map((draft) => (draft.key === key ? { ...draft, text: text.slice(0, NOTE_TEXT_MAX) } : draft))
      publish()
      persist(500)
    },
    [persist, publish, store],
  )

  const discard = useCallback(
    (key: string) => {
      if (!store.drafts?.some((draft) => draft.key === key)) return
      store.drafts = store.drafts.filter((draft) => draft.key !== key)
      publish()
      persist(0)
    },
    [persist, publish, store],
  )

  const send = useCallback(
    async (key: string) => {
      const draft = store.drafts?.find((entry) => entry.key === key)
      if (!draft || draft.text.trim() === '') return
      const message = noteMessage(draft)
      const status = runRef.current.status
      let outcome: { phase: 'queued'; queueId: string } | { phase: 'running' }
      const reopen = async () => {
        await continueRun(runId, { text: message })
        return { phase: 'running' } as const
      }
      if (status === 'running' || status === 'waiting') {
        try {
          const result = await queueRunPrompt(runId, message)
          outcome = 'delivered' in result ? { phase: 'running' } : { phase: 'queued', queueId: result.message.id }
        } catch (error) {
          // The session closed between the status this window held and the send.
          if (!(error instanceof ApiError) || error.status !== 409 || !/session closed/.test(error.message)) throw error
          outcome = await reopen()
        }
      } else if (status === 'queued') {
        // Not started yet: the note becomes part of the task's first prompt (#472).
        await sendMessage(runId, { text: message })
        outcome = { phase: 'running' }
      } else {
        outcome = await reopen()
      }
      const now = Date.now()
      store.counter++
      store.sent = [
        ...store.sent,
        {
          key,
          pick: draft.pick,
          text: draft.text.trim(),
          number: store.counter,
          sawRunning: false,
          ...(outcome.phase === 'queued'
            ? { phase: 'queued' as const, queueId: outcome.queueId, queuedAt: now }
            : { phase: 'running' as const, deliveredAt: now }),
        },
      ]
      store.drafts = (store.drafts ?? []).filter((entry) => entry.key !== key)
      publish()
      persist(0)
    },
    [persist, publish, runId, store],
  )

  const saveQueued = useCallback(
    async (key: string, text: string) => {
      const note = store.sent.find((entry) => entry.key === key)
      if (!note || note.phase !== 'queued' || note.queueId === undefined) throw new Error('This note has already gone to the agent.')
      const next = { ...note, text: text.trim().slice(0, NOTE_TEXT_MAX) }
      try {
        await editQueuedRunPrompt(runId, note.queueId, noteMessage(next))
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error('This note has already gone to the agent.')
        throw error
      }
      store.sent = store.sent.map((entry) => (entry.key === key ? { ...entry, text: next.text } : entry))
      publish()
    },
    [publish, runId, store],
  )

  const withdraw = useCallback(
    async (key: string) => {
      const note = store.sent.find((entry) => entry.key === key)
      if (!note || note.phase !== 'queued' || note.queueId === undefined) throw new Error('This note has already gone to the agent.')
      try {
        await removeQueuedRunPrompt(runId, note.queueId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error('This note has already gone to the agent.')
        throw error
      }
      store.sent = store.sent.filter((entry) => entry.key !== key)
      publish()
    },
    [publish, runId, store],
  )

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `store.version` is the store's change signal
  const notes = useMemo<DesignNote[]>(
    () => [...(store.drafts ?? []).map((draft) => ({ ...draft, phase: 'draft' as const })), ...store.sent],
    [store, store.version],
  )
  const marks = useMemo<DesignMark[]>(
    () =>
      notes.map((entry) =>
        entry.phase === 'draft'
          ? { key: entry.key, selector: entry.pick.selector, path: pathOf(entry.pick.url), label: pickLabel(entry.pick), draft: true }
          : { key: entry.key, n: entry.number, label: pickLabel(entry.pick), draft: false },
      ),
    [notes],
  )
  const note = useCallback((key: string) => notes.find((entry) => entry.key === key), [notes])

  return { notes, marks, note, addDraft, setText, discard, send, saveQueued, withdraw }
}

import { useSyncExternalStore } from 'react'

import { cn } from '@/lib/utils'

/**
 * A minimal toast primitive — the transient "that worked / that didn't" line the legacy UI
 * called `alertBar`. Deliberately not a library: the cockpit needs exactly one behavior
 * (message in, auto-dismiss after a beat) and every dependency lands in the shipped bundle.
 *
 * Module-level store + `useSyncExternalStore` so `toast()` is callable from anywhere —
 * mutation callbacks, event handlers — without threading a context through the tree. The one
 * `<Toaster />` instance (mounted at the app root) renders whatever the store holds.
 */

export type ToastTone = 'default' | 'danger'

/** An optional trailing action: a link ("go here", the star ask's repository) or an undo of what
 *  the toast announces. A callback only ever undoes, since a toast is transient and an arbitrary
 *  action that outlives it is a bug waiting to be written. */
export type ToastAction =
  | { label: string; href: string }
  /** An in-place undo (Needs you's Dismiss, spec 2026-11-23-needs-you-triage): clicking it also closes the toast. */
  | { label: string; onClick: () => void }

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  action?: ToastAction
  /** `true` once the lifetime timer fired. The item stays in the store — and mounted — for
   *  `EXIT_MS` longer so the exit animation has something to animate; dropping it here is
   *  what made the old toast vanish with no transition. */
  exiting: boolean
}

const TOAST_MS = 5000
/** Exit-animation window. Keep in step with the `duration-200` on the toast's animation
 *  classes below: the node is removed once this elapses, so a shorter value would cut the
 *  slide-out off mid-flight. */
const EXIT_MS = 200

let items: readonly ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
/** Every pending lifetime/exit timer, so `resetToasts()` can cancel them — an orphaned timer
 *  would publish into the *next* test's store. */
const timers = new Set<ReturnType<typeof setTimeout>>()

function publish(next: readonly ToastItem[]): void {
  items = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Observers of `danger` toasts — telemetry reports each one (`lib/telemetry.ts`). A hook rather
 *  than an import so this primitive stays dependency-free. */
const dangerListeners = new Set<(message: string) => void>()

export function onDangerToast(listener: (message: string) => void): () => void {
  dangerListeners.add(listener)
  return () => dangerListeners.delete(listener)
}

/** `setTimeout` that keeps its handle cancellable until it actually runs. */
function schedule(fn: () => void, ms: number): void {
  const handle = setTimeout(() => {
    timers.delete(handle)
    fn()
  }, ms)
  timers.add(handle)
}

/**
 * Show a transient message. `danger` tone for failures — the message should be the server's own
 * words wherever one exists (see ApiError).
 *
 * `action` appends one link; `durationMs` overrides the five-second default, for the rare toast
 * that asks the reader to decide something rather than telling them what already happened. Both
 * are optional and both default to exactly the previous behavior. `reported` marks a `danger`
 * toast whose failure the caller already reported with its own fingerprint, so the observers skip it.
 * `expected` marks one that is an expected, user-actionable outcome — a validation limit, a 409
 * guarding a precondition, a CLI that is not installed: shown, never reported as an error.
 */
/** The browser's own words for a request that got no answer — Chromium, WebKit, Firefox. */
const RAW_TRANSPORT_MESSAGES = new Set([
  'Failed to fetch',
  'network error',
  'Load failed',
  'The network connection was lost.',
  'NetworkError when attempting to fetch resource.',
])

export const UNREACHABLE_TOAST = 'cannot reach the cezar server — check the connection and try again'

/** A raw transport `TypeError` that escaped the client's `ApiError(0)` mapping (a body read that
 *  failed after the headers arrived) still says something a user can act on (telemetry 2e454012). */
export function friendlyToastMessage(message: string): string {
  return RAW_TRANSPORT_MESSAGES.has(message.trim()) ? UNREACHABLE_TOAST : message
}

/** A toast's remaining life, for one that pauses while the pointer or focus is on it (`onHold`). */
interface Life {
  handle?: ReturnType<typeof setTimeout>
  remaining: number
  startedAt: number
  onHold?: (held: boolean) => void
}
const lives = new Map<number, Life>()

function expire(id: number): void {
  lives.delete(id)
  publish(items.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
  schedule(() => publish(items.filter((t) => t.id !== id)), EXIT_MS)
}

function live(id: number, life: Life): void {
  life.startedAt = Date.now()
  const handle = setTimeout(() => {
    timers.delete(handle)
    expire(id)
  }, life.remaining)
  life.handle = handle
  timers.add(handle)
}

/** Pointer or focus on a holdable toast: its clock and what it guards (an undo window) wait. */
export function holdToast(id: number, held: boolean): void {
  const life = lives.get(id)
  if (!life) return
  if (held && life.handle !== undefined) {
    clearTimeout(life.handle)
    timers.delete(life.handle)
    life.handle = undefined
    life.remaining = Math.max(0, life.remaining - (Date.now() - life.startedAt))
    life.onHold?.(true)
  } else if (!held && life.handle === undefined) {
    live(id, life)
    life.onHold?.(false)
  }
}

/** Closes one toast early: the undo it carried was used. */
export function dismissToast(id: number): void {
  const life = lives.get(id)
  if (life?.handle !== undefined) {
    clearTimeout(life.handle)
    timers.delete(life.handle)
  }
  lives.delete(id)
  if (!items.some((t) => t.id === id && !t.exiting)) return
  publish(items.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
  schedule(() => publish(items.filter((t) => t.id !== id)), EXIT_MS)
}

export function toast(
  rawMessage: string,
  opts: {
    tone?: ToastTone
    action?: ToastAction
    durationMs?: number
    reported?: boolean
    expected?: boolean
    /** The toast pauses while hovered or focused, and says so: an undo's window waits with it. */
    onHold?: (held: boolean) => void
  } = {},
): number {
  const message = friendlyToastMessage(rawMessage)
  const item: ToastItem = {
    id: nextId++,
    message,
    tone: opts.tone ?? 'default',
    ...(opts.action ? { action: opts.action } : {}),
    exiting: false,
  }
  const lifetime = opts.durationMs ?? TOAST_MS
  publish([...items, item])
  if (item.tone === 'danger' && !opts.reported && !opts.expected) {
    for (const listener of dangerListeners) {
      try {
        listener(message)
      } catch {
        // an observer must never stop the toast
      }
    }
  }
  // Two phases, one clock per toast: mark it exiting so the renderer can animate it out, then
  // remove it once the animation has played.
  if (opts.onHold) {
    const life: Life = { remaining: lifetime, startedAt: Date.now(), onHold: opts.onHold }
    lives.set(item.id, life)
    live(item.id, life)
    return item.id
  }
  schedule(() => {
    publish(items.map((t) => (t.id === item.id ? { ...t, exiting: true } : t)))
    schedule(() => publish(items.filter((t) => t.id !== item.id)), EXIT_MS)
  }, lifetime)
  return item.id
}

/** Test seam: clears the module-level queue *and* every pending timer, so one test's toasts
 *  never leak into the next. */
export function resetToasts(): void {
  for (const handle of timers) clearTimeout(handle)
  timers.clear()
  lives.clear()
  publish([])
}

export function Toaster() {
  const current = useSyncExternalStore(subscribe, () => items)
  if (current.length === 0) return null
  return (
    <div
      data-slot="toaster"
      // Top-right, the placement web apps have standardised on: bottom-centre landed straight
      // on the thread's action row. z-[60] clears the Radix overlay layer (z-50) — dialogs fire
      // toasts, and their portal sits later in <body>, so at an equal z-index the dialog wins.
      //
      // The mobile offset clears the app shell's own header (app-shell.tsx: a 52px row plus its
      // border, under the safe-area inset) whose right end holds the run status dot and kebab.
      // Anchoring at 16px on a phone would cover exactly the controls #818 is about, which is
      // the bug moved rather than fixed; `md:` is where that header stops rendering.
      className="pointer-events-none fixed top-[calc(61px+env(safe-area-inset-top))] right-[calc(16px+env(safe-area-inset-right))] z-[60] flex flex-col items-end gap-2 md:top-[calc(16px+env(safe-area-inset-top))]"
    >
      {current.map((item) => (
        <div
          key={item.id}
          role="status"
          data-slot="toast"
          data-tone={item.tone}
          data-state={item.exiting ? 'closed' : 'open'}
          onPointerEnter={() => holdToast(item.id, true)}
          onPointerLeave={() => holdToast(item.id, false)}
          onFocus={() => holdToast(item.id, true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) holdToast(item.id, false)
          }}
          className={cn(
            'pointer-events-auto max-w-[min(360px,calc(100vw-32px))] rounded-md px-3.5 py-2.5 text-ui font-medium shadow-modal',
            // tw-animate-css utilities (imported in styles/index.css), the same vocabulary the
            // shadcn primitives use. motion-safe: so `prefers-reduced-motion` keeps the instant
            // appear/disappear it had before.
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4 motion-safe:duration-200',
            'motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:slide-out-to-right-4',
            item.tone === 'danger'
              ? 'bg-danger text-danger-foreground'
              : 'bg-contrast text-contrast-foreground',
          )}
        >
          {item.message}
          {item.action && 'onClick' in item.action ? (
            <>
              {' '}
              <button
                type="button"
                data-slot="toast-action"
                onClick={() => {
                  if (!item.action || !('onClick' in item.action)) return
                  item.action.onClick()
                  dismissToast(item.id)
                }}
                className="font-semibold underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {item.action.label}
              </button>
            </>
          ) : item.action ? (
            <>
              {' '}
              <a
                data-slot="toast-action"
                href={item.action.href}
                target="_blank"
                // Same reasoning as the sidebar's ⭐ chip: a local cockpit's URL is nobody's
                // business, least of all the site the toast is pointing at.
                rel="noopener noreferrer"
                className="font-semibold underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {item.action.label}
              </a>
            </>
          ) : null}
        </div>
      ))}
    </div>
  )
}

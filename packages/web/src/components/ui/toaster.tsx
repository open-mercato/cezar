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

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

const TOAST_MS = 5000

let items: readonly ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()

function publish(next: readonly ToastItem[]): void {
  items = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Show a transient message. `danger` tone for failures — the message should be the server's
 *  own words wherever one exists (see ApiError). */
export function toast(message: string, opts: { tone?: ToastTone } = {}): void {
  const item: ToastItem = { id: nextId++, message, tone: opts.tone ?? 'default' }
  publish([...items, item])
  setTimeout(() => publish(items.filter((t) => t.id !== item.id)), TOAST_MS)
}

/** Test seam: clears the module-level queue so one test's toasts never leak into the next. */
export function resetToasts(): void {
  publish([])
}

export function Toaster() {
  const current = useSyncExternalStore(subscribe, () => items)
  if (current.length === 0) return null
  return (
    <div
      data-slot="toaster"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4"
    >
      {current.map((item) => (
        <div
          key={item.id}
          role="status"
          data-slot="toast"
          data-tone={item.tone}
          className={cn(
            'pointer-events-auto max-w-full rounded-md px-3.5 py-2.5 text-[13px] font-medium shadow-modal',
            item.tone === 'danger'
              ? 'bg-danger text-danger-foreground'
              : 'bg-contrast text-contrast-foreground',
          )}
        >
          {item.message}
        </div>
      ))}
    </div>
  )
}

import { toast as sonnerToast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Toaster as Sonner } from '@/components/ui/sonner'

/**
 * The cockpit's toast API — the transient "that worked / that didn't" line — as a thin
 * compatibility layer over shadcn/ui Sonner (`ui/sonner.tsx`). The call shape is the one the app
 * has always used, `toast(message, { tone, action, durationMs })`, so no call site knows which
 * library renders it. `toast()` stays callable from anywhere (mutation callbacks, event
 * handlers); the one `<Toaster />` instance is mounted at the app root.
 */

export type ToastTone = 'default' | 'danger'

/** An optional trailing link. Deliberately a LINK and not a callback: a toast is transient, and
 *  an arbitrary action that outlives its own toast is a bug waiting to be written. Everything
 *  that needs one so far is "go here" (the star ask's repository). */
export interface ToastAction {
  label: string
  href: string
}

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  action?: ToastAction
  exiting: boolean
}

const TOAST_MS = 5000

/**
 * Show a transient message. `danger` tone for failures — the message should be the server's own
 * words wherever one exists (see ApiError).
 *
 * `action` appends one link; `durationMs` overrides the five-second default, for the rare toast
 * that asks the reader to decide something rather than telling them what already happened.
 */
export function toast(
  message: string,
  opts: { tone?: ToastTone; action?: ToastAction; durationMs?: number } = {},
): void {
  const show = opts.tone === 'danger' ? sonnerToast.error : sonnerToast
  show(message, {
    duration: opts.durationMs ?? TOAST_MS,
    ...(opts.action
      ? {
          // A node, not sonner's `{ label, onClick }`: the action stays a real link, so it opens
          // in a new tab with no opener or referrer — a local cockpit's URL is nobody's
          // business, least of all the site the toast is pointing at.
          action: (
            <Button
              asChild
              size="xs"
              variant="secondary"
              data-slot="toast-action"
              className="ml-auto"
            >
              <a href={opts.action.href} target="_blank" rel="noopener noreferrer">
                {opts.action.label}
              </a>
            </Button>
          ),
        }
      : {}),
  })
}

/** Test seam: drops every toast on screen, so one test's toasts never leak into the next. */
export function resetToasts(): void {
  sonnerToast.dismiss()
}

export function Toaster() {
  return (
    <Sonner
      // Top-right, the placement web apps have standardised on: bottom-centre landed straight
      // on the thread's action row (#818).
      position="top-right"
      // Every live toast readable at once, each on its own clock — not a collapsed deck.
      expand
      offset={{
        top: 'calc(16px + env(safe-area-inset-top))',
        right: 'calc(16px + env(safe-area-inset-right))',
      }}
      // Below `md` the app shell renders its own header (a 52px row plus its border, under the
      // safe-area inset) whose right end holds the run status dot and kebab — the toast must
      // clear it. Sonner's own "mobile" stops at 600px, so the `max-md:` override carries the
      // same offset up to where that header stops rendering.
      mobileOffset={{
        top: 'calc(61px + env(safe-area-inset-top))',
        right: 'calc(16px + env(safe-area-inset-right))',
        left: 'calc(16px + env(safe-area-inset-left))',
      }}
      className="toaster group max-md:[--offset-top:calc(61px+env(safe-area-inset-top))]!"
      toastOptions={{
        classNames: {
          // `pointer-events-auto`: a modal Radix Dialog turns pointer events off on <body>, and
          // dialogs fire toasts — without it a toast above an open dialog could not be clicked.
          // (Sonner's own z-index already clears the z-50 overlay layer.)
          toast: 'pointer-events-auto text-[13px]! font-medium shadow-modal!',
        },
      }}
    />
  )
}

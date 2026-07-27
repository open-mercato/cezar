import type { LinkSafetyModalProps } from 'streamdown'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * The confirm step for a link inside rendered markdown — cezar's replacement for Streamdown's
 * own link-safety modal.
 *
 * WHY IT EXISTS AT ALL (this is a bug fix, not a restyle). Streamdown ships link safety ON by
 * default (`linkSafety: { enabled: true }`), which turns every markdown link into a button and
 * renders its confirm modal INLINE — a bare `fixed inset-0 … backdrop-blur-sm` div next to the
 * link, with no portal. A `position: fixed` box only resolves against the viewport while no
 * ancestor establishes a containing block for it, and the thread's rows do exactly that: they
 * carry `content-visibility: auto` (thread-scroller.tsx, THE PERFORMANCE RULE), which implies
 * `contain: layout paint style`. Paint containment makes the row both the containing block AND
 * the clip rect, so Streamdown's modal landed *inside the message you clicked in*: the reader
 * saw a blurred rectangle where the message used to be, the dialog itself parked off-screen at
 * the row's centre, and no amount of scrolling brought it into view.
 *
 * Routing the modal through `renderModal` fixes it at the root: `AlertDialogContent` portals to
 * `document.body`, which is outside every contained row, so the dialog is viewport-centred
 * again wherever the link lives. It also buys the focus trap, the Escape handler and
 * `role="alertdialog"` that the inline modal did not have.
 *
 * The confirm itself is kept rather than switched off (`linkSafety: { enabled: false }` would
 * have been the one-line "fix"): a transcript's link TEXT is written by the agent, which in
 * turn reads untrusted repo and tracker content, so the address behind it is exactly the thing
 * worth showing before the browser follows it — the same reasoning as the `isHttpUrl` href
 * guard (#431) and display-only tool issue links (#538).
 */
export function LinkSafetyDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent data-slot="link-safety-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Open this link?</AlertDialogTitle>
          {/* The address rides INSIDE the description on purpose: Radix points the dialog's
              `aria-describedby` at this node, and the address is the whole reason the prompt
              exists — a screen reader that announced only the sentence would leave its user
              with exactly the question the dialog was opened to answer. A <span> (block only
              by CSS) because the description renders a <p>, which cannot contain a <div>. */}
          <AlertDialogDescription>
            It leaves cezar in a new tab. The words of a link in a transcript are the
            agent&apos;s — the address below is where it actually goes.
            {/* The full URL, never truncated: a shortened address is exactly the one a reader
                cannot check. `wrap-anywhere` keeps a long one inside the dialog. */}
            <span
              data-slot="link-safety-url"
              className="mt-3 block wrap-anywhere rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
            >
              {url}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Streamdown's `onConfirm` is the one that opens the tab (`_blank`, `noreferrer`);
              the Action also closes the dialog, which is what fires `onClose`. */}
          <AlertDialogAction onClick={onConfirm}>Open link</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

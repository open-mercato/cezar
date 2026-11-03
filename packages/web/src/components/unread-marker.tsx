/**
 * The unread marker (#unread-done-items) — for assistive tech only.
 *
 * Sighted readers get unread from the title's weight (semibold + full foreground, against the
 * dimmed read history). It used to be a trailing violet dot as well, retired because violet is
 * already the STATUS dot's colour for running / monitoring / needs review / needs permission:
 * one row's leading violet said "working" while another's trailing violet said "unread".
 *
 * Weight is invisible to a screen reader, so the word stays in the accessibility tree. Render it
 * INSIDE the row's title link, so the link's accessible name carries it ("<title>, unread").
 * One component for every surface that lists a task, so the sidebar, the Tasks table, the mobile
 * card and the global Tasks page cannot drift apart.
 */
export function UnreadMarker() {
  return (
    <span data-slot="unread-marker" className="sr-only">
      , unread
    </span>
  )
}

import { ZapIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { toast } from '@/components/ui/toaster'

export function BookmarkletRow({
  label,
  url,
  hint,
  showIcon = true,
  copySlot = 'bm-copy',
}: {
  label: string
  url: string
  hint?: string
  showIcon?: boolean
  copySlot?: string
}) {
  // React refuses javascript: hrefs at render time, but dragging needs the real URL on the DOM node.
  const anchor = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    anchor.current?.setAttribute('href', url)
  }, [url])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast('Bookmarklet URL copied.')
    } catch {
      toast('Copy failed — drag the button instead.', { tone: 'danger' })
    }
  }

  return (
    <div data-slot="bm-row" className="flex min-w-0 items-center gap-2.5">
      {/* Drag source only: a click must never execute the javascript: URL. */}
      <a
        ref={anchor}
        draggable
        data-slot="bm-link"
        title="Drag me to your bookmarks bar"
        onClick={(event) => {
          event.preventDefault()
          toast('Drag me to your bookmarks bar')
        }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-mono text-xs font-medium text-foreground shadow-xs transition-colors hover:bg-muted"
      >
        {showIcon ? <ZapIcon aria-hidden="true" className="size-3 text-primary" /> : null}
        {label}
      </a>
      <button
        type="button"
        data-slot={copySlot}
        title="Copy the bookmarklet URL"
        onClick={() => void copy()}
        className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Copy
      </button>
      {hint ? <span className="min-w-0 truncate text-[11px] text-soft-foreground">{hint}</span> : null}
    </div>
  )
}

import { SearchIcon } from 'lucide-react'

import { openCommandPalette } from '@/components/command-palette'
import { commandShortcutHint } from '@/lib/use-command-shortcut'
import { cn } from '@/lib/utils'

/**
 * The ⌘K discoverability affordance (Step 4.3): shaped like a search input — magnifier, a
 * muted `Search…` label, the chord parked on the right. It was a chip cut from the version
 * chip's cloth until #702, where the sidebar footer's five chips overflowed the 264px column;
 * giving search the whole line is what makes the remaining controls fit on one row, and it
 * reads as the launcher it is rather than as a keyboard-shortcut footnote.
 *
 * Rendered in two places since the unified settings (spec 2026-10-13): the sidebar footer, and
 * the bottom of the settings nav — settings is full-screen with no sidebar, and the launcher is
 * what keeps the palette findable there. One component so the two can never drift.
 *
 * Still a button, not an input: there is no search *here*; clicking opens the palette through
 * the same programmatic seam anything else would, and the palette owns the real input.
 *
 * No `aria-label`: the visible `Search…` already names it, and an override that merely drops
 * the ellipsis would make the accessible name diverge from the label a speech user reads
 * aloud (WCAG 2.5.3). The chord rides `commandShortcutHint` so the kbd shows Ctrl+K off Apple
 * hardware, per the spec's platform-symbol rule.
 */
export function CommandPaletteHint({ className }: { className?: string }) {
  return (
    <button
      type="button"
      data-slot="command-palette-hint"
      title="Search — command palette (⌘K / Ctrl+K)"
      onClick={() => openCommandPalette()}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-left text-xs font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">Search…</span>
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground"
      >
        {commandShortcutHint('k')}
      </kbd>
    </button>
  )
}

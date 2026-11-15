import { ChevronRightIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { JUNK_FOLD_AT } from './file-tree'

/**
 * The de-emphasised tail of a folder: its images, binaries and OS cruft (`isJunkPath`), rendered
 * after the source files in the muted ink. Up to `JUNK_FOLD_AT` rows show inline; past that they
 * fold under one row — closed by default, but opened for the reader whenever the selected file is
 * among them, so a click-through from a diff never lands on a hidden row. Never hides a count: the
 * folder's ± already includes these files, and the fold row says how many it holds.
 */
export function JunkFold({
  count,
  depth,
  forceOpen = false,
  children,
}: {
  count: number
  depth: number
  /** The selected row lives inside — keep it reachable. */
  forceOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (count === 0) return null
  if (count <= JUNK_FOLD_AT) return <>{children}</>
  const shown = open || forceOpen
  return (
    <li data-slot="tree-junk" data-state={shown ? 'open' : 'closed'}>
      <button
        type="button"
        data-slot="tree-junk-fold"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-label text-soft-foreground hover:bg-muted hover:text-muted-foreground"
        style={{ paddingLeft: `${24 + depth * 14}px` }}
      >
        <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 shrink-0 transition-transform', shown && 'rotate-90')} />
        <span className="min-w-0 truncate">
          {count} {count === 1 ? 'file' : 'files'} — images, binaries and other untracked junk
        </span>
      </button>
      {shown ? <ul className="flex flex-col gap-px">{children}</ul> : null}
    </li>
  )
}

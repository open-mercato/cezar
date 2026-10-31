import { BotIcon, EllipsisIcon, ListChecksIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useHealth, useProjects } from '@/api/queries'
import { useKeyboardOpen } from '@/lib/keyboard-inset'
import { readStoredLastLocation } from '@/lib/last-location'
import { lastProjectIndex } from '@/lib/phone-app'
import { cn } from '@/lib/utils'

const ITEM =
  'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-meta font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50'
const CURRENT = 'font-semibold text-foreground'

/**
 * Manager, Tasks and More for the shell and a phone PWA (spec 2026-10-31-mobile-apps-manager-first,
 * Navigation). `md:hidden`: a phone wide enough in landscape has the real sidebar instead. Mounted
 * only there, which is what lets it read the query cache from the QueryClient-free shell.
 */
export function PhoneBottomBar({
  manager,
  attention,
  menuOpen,
  onMore,
}: {
  manager: boolean
  attention: boolean
  menuOpen: boolean
  onMore: () => void
}) {
  const keyboardOpen = useKeyboardOpen()
  const health = useHealth()
  const projects = useProjects()
  if (keyboardOpen) return null
  const bootProject = projects.data?.bootProject ?? health.data?.bootProject
  return (
    <nav aria-label="App" data-slot="phone-bottom-bar" className="flex border-t border-border bg-background md:hidden">
      <Link to="/manager" aria-current={manager ? 'page' : undefined} className={cn(ITEM, manager && CURRENT)}>
        <BotIcon className="size-5" aria-hidden="true" />
        Manager
        {attention ? (
          <span data-slot="bottom-bar-attention" className="absolute top-2 left-[calc(50%+8px)] flex">
            <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />
            <span className="sr-only">, needs you</span>
          </span>
        ) : null}
      </Link>
      <Link
        to={lastProjectIndex(readStoredLastLocation(), projects.data, bootProject)}
        aria-current={manager ? undefined : 'page'}
        className={cn(ITEM, !manager && CURRENT)}
      >
        <ListChecksIcon className="size-5" aria-hidden="true" />
        Tasks
      </Link>
      {/* Not a SheetTrigger: Radix keeps one trigger ref, and this one unmounts with the keyboard,
          which would strand the top bar's focus return. */}
      <button type="button" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={onMore} className={ITEM}>
        <EllipsisIcon className="size-5" aria-hidden="true" />
        More
      </button>
    </nav>
  )
}

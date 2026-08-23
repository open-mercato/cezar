import { ChevronDownIcon, FolderOpenIcon, ListChecksIcon } from 'lucide-react'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import type { NavItem } from '@/components/nav-items'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * Recency order: the active project pinned first, then `lastOpenedAt` descending — the sidebar's
 * Projects section reads it; the list itself no longer lives on the bar.
 */
export function orderForSwitcher(
  projects: readonly ProjectListEntry[],
  activeId: string | null,
): ProjectListEntry[] {
  return [...projects].sort((a, b) => {
    if (a.id === activeId) return -1
    if (b.id === activeId) return 1
    return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '')
  })
}

/**
 * The bar's project chip and ITS menu (user decision): the active project's own views — Tasks,
 * then Git / Skills / Workflows (and the gated Inbox / GitHub / Automations),
 * then Settings — never a list of other projects, which the sidebar's Projects section owns.
 * The chip is the breadcrumb's first step; the menu is where that step leads.
 */
export function ProjectSwitcher({
  projects,
  activeId,
  items,
  activeTo,
  inboxCount = null,
  skillsUpdateAvailable = false,
}: {
  projects: readonly ProjectListEntry[]
  activeId: string | null
  /** The project's views, already availability-gated (`visibleNavItems`). */
  items: NavItem[]
  /** `activeNavPath(...)` of the current URL — the lit row. */
  activeTo: string | null
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
}) {
  const active = projects.find((project) => project.id === activeId)
  const name = active?.name ?? activeId ?? projects[0]?.name ?? ''
  const views = items.filter((item) => item.to !== '/' && !item.global)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="project-switcher"
          aria-label={`${name}: project menu`}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
          <span data-slot="repo-chip" className="truncate font-mono text-[12px] font-medium text-muted-foreground">
            {name}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-slot="project-menu" className="w-56">
        {/* No name label and no "Open project" (user feedback: both repeated the chip). The
            first row is what the project opens to — its Tasks — then the rest of its views. */}
        <DropdownMenuItem asChild>
          <Link
            to="/"
            data-slot="project-open"
            data-nav-to="/"
            aria-current={activeTo === '/' ? 'page' : undefined}
            className={cn(activeTo === '/' && 'bg-primary/10 font-semibold text-foreground')}
          >
            <ListChecksIcon aria-hidden="true" />
            Tasks
          </Link>
        </DropdownMenuItem>
        {views.map((item) => {
          const Icon = item.icon
          const lit = item.to === activeTo
          return (
            <DropdownMenuItem key={item.to} asChild>
              <Link
                to={item.to}
                data-nav-to={item.to}
                aria-current={lit ? 'page' : undefined}
                className={cn(lit && 'bg-primary/10 font-semibold text-foreground')}
              >
                <Icon aria-hidden="true" />
                {item.label}
                {item.badge === 'inbox-count' && inboxCount ? (
                  <span data-slot="nav-badge" className="ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground">
                    {inboxCount}
                  </span>
                ) : null}
                {item.badge === 'skills-update' && skillsUpdateAvailable ? (
                  <span data-slot="nav-update-marker" className="ml-auto flex items-center">
                    <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
                    <span className="sr-only">Skills update available</span>
                  </span>
                ) : null}
              </Link>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

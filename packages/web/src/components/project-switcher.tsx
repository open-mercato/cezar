import * as React from 'react'
import { CheckIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon, SlidersHorizontalIcon } from 'lucide-react'
import { useNavigate as useRouterNavigate } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { GithubIcon } from '@/components/icons'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { scopeTo, useNavigate } from '@/lib/project-router'

/** Type-to-filter appears from this many projects up. Below it the list is scannable at a
 *  glance and an input would be chrome with nothing to earn. */
const FILTER_THRESHOLD = 8

/**
 * Recency order (25-repo review): the switcher is reached for the project you were JUST in,
 * so `lastOpenedAt` descending — with the active project pinned first as the anchor the check
 * confirms. Registry order (insertion) made the most-used repo as far away as its age.
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
 * The topbar's project identity as a real SWITCHER (design review): clicking the name lists the
 * registered projects (check on the active one) and lands in the picked one's tasks — a separate
 * mental model from "+ Add project", which sits beside it and only ever ADDS.
 *
 * A `Command` in a popover rather than a `DropdownMenu` (25-repo review): a large registry
 * needs type-to-filter, and the menu primitive's typeahead would eat the keystrokes an input
 * needs. The list caps its height and scrolls; the filter input appears from 8 projects up.
 *
 * The chevron renders even with ONE project (review): it is what says "this is a switcher" —
 * and the menu is never dead, since Manage projects always lives at its bottom.
 */
export function ProjectSwitcher({
  projects,
  activeId,
}: {
  projects: readonly ProjectListEntry[]
  activeId: string | null
}) {
  const [open, setOpen] = React.useState(false)
  // The add-project dialogs live here now (user decision: one project menu — the list, then
  // add, then manage — rather than a second control beside it). Mounted only while open.
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const navigate = useNavigate()
  const routerNavigate = useRouterNavigate()
  const active = projects.find((project) => project.id === activeId)
  const name = active?.name ?? activeId ?? projects[0]?.name ?? ''
  const ordered = orderForSwitcher(projects, activeId)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="project-switcher"
          aria-label="Switch project"
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
          <span data-slot="repo-chip" className="truncate font-mono text-[12px] font-medium text-muted-foreground">
            {name}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          {projects.length >= FILTER_THRESHOLD ? (
            <CommandInput data-slot="project-filter" placeholder="Filter projects…" />
          ) : null}
          {/* The cap is what keeps 25 registered repos from being a menu the height of the
              screen — the tail scrolls, the filter above skips the scroll entirely. */}
          <CommandList className="max-h-[min(48vh,380px)]">
            <CommandEmpty>No project matches.</CommandEmpty>
            <CommandGroup>
              {ordered.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.name}
                  data-project-id={project.id}
                  // Same guard as the ⌘K palette: a missing folder cannot be entered.
                  disabled={project.status === 'missing'}
                  onSelect={() => {
                    setOpen(false)
                    navigate(scopeTo(project.id, '/'))
                  }}
                >
                  <FolderOpenIcon aria-hidden="true" className="text-soft-foreground" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {project.id === activeId ? (
                    <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {/* The footer sits OUTSIDE the scrolling list (user feedback: with 25 projects it was
              below the fold). Plain buttons, so the list's filter and keyboard travel stay the
              list's; these three are always in view and always one click. */}
          <div data-slot="switcher-footer" className="flex flex-col gap-0.5 border-t border-border p-1">
            <FooterAction
              slot="add-project-local"
              icon={<FolderIcon aria-hidden="true" className="size-3.5" />}
              label="Add local folder…"
              onSelect={() => {
                setOpen(false)
                setBrowsing(true)
              }}
            />
            <FooterAction
              slot="add-project-clone"
              icon={<GithubIcon aria-hidden="true" className="size-3.5" />}
              label="Clone from GitHub…"
              onSelect={() => {
                setOpen(false)
                setCloning(true)
              }}
            />
            <FooterAction
              slot="manage-projects"
              icon={<SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />}
              label="Manage projects"
              onSelect={() => {
                setOpen(false)
                // Plain router target: the registry lives in GLOBAL settings, outside every project.
                routerNavigate('/settings/global/projects')
              }}
            />
          </div>
        </Command>
      </PopoverContent>
      {browsing ? <AddProjectDialog open onOpenChange={setBrowsing} /> : null}
      {cloning ? <CloneProjectDialog open onOpenChange={setCloning} /> : null}
    </Popover>
  )
}

function FooterAction({
  slot,
  icon,
  label,
  onSelect,
}: {
  slot: string
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-slot={slot}
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {icon}
      {label}
    </button>
  )
}

import * as React from 'react'
import { CheckIcon, FolderOpenIcon, FolderPlusIcon, SearchIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { useSidebarNavigate } from '@/components/app-shell'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { GithubIcon } from '@/components/icons'
import { orderForSwitcher } from '@/components/project-switcher'
import { cn } from '@/lib/utils'

/** How many projects the section shows before "Load more" — and how many each load adds. */
const PAGE = 10

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

/**
 * The sidebar's Projects section (user decision): the ten most recently used projects as rows,
 * "Load more" for the rest, and the section's verbs as icons on its header — search (an inline
 * filter), add a local folder, clone from GitHub, manage the registry. A row opens that
 * project's tasks; the active one wears a check. Same registry the bar's switcher reads.
 */
export function ProjectsSection({
  projects,
  activeId,
}: {
  projects: readonly ProjectListEntry[]
  activeId: string | null
}) {
  const [searching, setSearching] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [limit, setLimit] = React.useState(PAGE)
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const onNavigate = useSidebarNavigate()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const ordered = orderForSwitcher(projects, activeId)
  const needle = query.trim().toLowerCase()
  const matching = needle ? ordered.filter((p) => p.name.toLowerCase().includes(needle)) : ordered
  // A filter shows everything it matches — paging is for browsing, not for hiding hits.
  const shown = needle ? matching : matching.slice(0, limit)
  const hidden = matching.length - shown.length

  const toggleSearch = () => {
    setSearching((on) => {
      if (on) setQuery('')
      return !on
    })
    // Focus after the input mounts.
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <section data-slot="projects-section" className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center pr-1 pl-3">
        <h2 className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Projects</h2>
        <span className="ml-auto flex items-center gap-0.5">
          <button type="button" data-slot="projects-search" aria-label="Search projects" aria-pressed={searching} title="Search projects" onClick={toggleSearch} className={cn(ICON_BUTTON, searching && 'text-foreground')}>
            <SearchIcon className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" data-slot="add-project-local" aria-label="Add local folder" title="Add local folder" onClick={() => setBrowsing(true)} className={ICON_BUTTON}>
            <FolderPlusIcon className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" data-slot="add-project-clone" aria-label="Clone from GitHub" title="Clone from GitHub" onClick={() => setCloning(true)} className={ICON_BUTTON}>
            <GithubIcon className="size-3.5" aria-hidden="true" />
          </button>
          <RouterLink to="/settings/global/projects" data-slot="manage-projects" aria-label="Manage projects" title="Manage projects" onClick={onNavigate} className={ICON_BUTTON}>
            <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
          </RouterLink>
        </span>
      </div>

      {searching ? (
        <div className="relative px-1 pb-1">
          <input
            ref={inputRef}
            data-slot="projects-filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') toggleSearch()
            }}
            placeholder="Filter projects…"
            aria-label="Filter projects"
            className="h-8 w-full rounded-md border border-input bg-card px-2.5 pr-7 text-[13px] outline-none placeholder:text-soft-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <button type="button" aria-label="Close search" onClick={toggleSearch} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-soft-foreground hover:text-foreground">
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {shown.map((project) => {
        const active = project.id === activeId
        const missing = project.status === 'missing'
        return (
          <RouterLink
            key={project.id}
            to={`/p/${project.id}/`}
            data-slot="project-row"
            data-project-id={project.id}
            aria-current={active ? 'page' : undefined}
            aria-disabled={missing || undefined}
            onClick={(event) => {
              if (missing) event.preventDefault()
              else onNavigate?.()
            }}
            title={missing ? `${project.name} (folder missing)` : project.name}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground md:h-8',
              active && 'bg-card font-semibold text-foreground shadow-xs',
              missing && 'opacity-50 hover:bg-transparent',
            )}
          >
            <FolderOpenIcon className="size-3.5 shrink-0 text-soft-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {active ? <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
          </RouterLink>
        )
      })}
      {shown.length === 0 ? <p className="px-3 py-1.5 text-xs text-soft-foreground">No project matches.</p> : null}
      {hidden > 0 ? (
        <button
          type="button"
          data-slot="projects-load-more"
          onClick={() => setLimit((n) => n + PAGE)}
          className="self-start rounded-sm px-3 py-1 text-[12px] text-soft-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Load {Math.min(hidden, PAGE)} more
        </button>
      ) : null}

      {browsing ? <AddProjectDialog open onOpenChange={setBrowsing} /> : null}
      {cloning ? <CloneProjectDialog open onOpenChange={setCloning} /> : null}
    </section>
  )
}

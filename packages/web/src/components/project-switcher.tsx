import { CheckIcon, ChevronDownIcon, FolderOpenIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { scopeTo, useNavigate } from '@/lib/project-router'

/**
 * The topbar's project identity as a real SWITCHER (design review): clicking the name lists the
 * registered projects (check on the active one) and lands in the picked one's tasks — a separate
 * mental model from "+ Add project", which sits beside it and only ever ADDS.
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
  const navigate = useNavigate()
  const active = projects.find((project) => project.id === activeId)
  const name = active?.name ?? activeId ?? projects[0]?.name ?? ''
  const identity = (
    <>
      <FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
      <span data-slot="repo-chip" className="truncate font-mono text-[12px] font-medium text-muted-foreground">
        {name}
      </span>
    </>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="project-switcher"
          aria-label="Switch project"
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {identity}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            data-project-id={project.id}
            // Same guard as the ⌘K palette: a missing folder cannot be entered.
            disabled={project.status === 'missing'}
            onSelect={() => navigate(scopeTo(project.id, '/'))}
          >
            <FolderOpenIcon aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === activeId ? (
              <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* Plain router link: the registry lives in GLOBAL settings, outside every project. */}
          <RouterLink to="/settings/global" data-slot="manage-projects">
            <SlidersHorizontalIcon aria-hidden="true" />
            Manage projects
          </RouterLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

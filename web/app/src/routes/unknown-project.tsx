import { FolderSearchIcon } from 'lucide-react'
import { Link } from 'react-router'

import type { ProjectsResponse } from '@/api/types'
import { CenteredState } from '@/components/centered-state'

/**
 * `/p/<unknown>/…` (multi-project spec, step 3.2): a deep link to a project this server has
 * never registered. The API side would 404 — this screen is the graceful shell for it: name the
 * problem, list what IS registered here, link out. Neutral tone on the 404 rule: a link to
 * someone else's workspace is a dead end, not a failure of ours.
 *
 * Plain `react-router` links on purpose: every target names its project explicitly, so the
 * scope-aware wrapper would have nothing to add.
 */
export function UnknownProjectRoute({
  projectId,
  registry,
}: {
  projectId: string
  registry: ProjectsResponse
}) {
  // The boot project is always openable even when the registry list is degraded-empty
  // (read-only home: the workspace file may not exist, but the boot repo is being served).
  const projects = registry.projects.length
    ? registry.projects
    : [{ id: registry.bootProject, name: registry.bootProject }]

  return (
    <div data-route="unknown-project" className="flex min-h-full flex-col">
      <CenteredState
        icon={<FolderSearchIcon />}
        tone="neutral"
        title={`“${projectId}” isn’t registered here`}
        subtitle="This cezar doesn’t serve a project by that id. The link may come from another machine’s workspace — these are the projects registered on this one:"
      >
        <ul data-slot="registered-projects" className="mx-auto flex w-full max-w-xs flex-col gap-1.5 text-left">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/p/${encodeURIComponent(project.id)}/`}
                className="flex items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-xs transition-colors hover:bg-card-2"
              >
                {project.name || project.id}
                <span className="font-mono text-[11px] font-normal text-soft-foreground">/p/{project.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CenteredState>
    </div>
  )
}

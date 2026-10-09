import { ChevronRightIcon, FolderSearchIcon } from 'lucide-react'
import { Link } from 'react-router'

import type { ProjectsResponse } from '@open-mercato/cezar-api-client'
import { ListEmpty, ListFrame } from '@/components/list-view'
import { Page, PageBody } from '@/components/page'

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
    <Page data-route="unknown-project" width="narrow">
      <PageBody className="flex flex-col justify-center py-10">
        <ListEmpty
          className="border-0"
          icon={<FolderSearchIcon />}
          title={<h1>{`“${projectId}” isn’t registered here`}</h1>}
          // "can open", not "registered on this one": the list below is the
          // `GET /api/v1/projects` payload, which since seed-once leads with the
          // folder cezar is serving WITHOUT having registered it.
          description="This workspace doesn’t serve a project by that id. The link may come from another machine’s workspace — these are the projects this one can open:"
          action={
            <ListFrame className="w-full text-left">
              <ul data-slot="registered-projects" className="divide-y divide-border">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Link
                      to={`/p/${encodeURIComponent(project.id)}/`}
                      className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1 truncate">{project.name || project.id}</span>
                      <span className="font-mono text-[11px] font-normal text-muted-foreground">/p/{project.id}</span>
                      <ChevronRightIcon className="size-4 shrink-0 text-soft-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            </ListFrame>
          }
        />
      </PageBody>
    </Page>
  )
}

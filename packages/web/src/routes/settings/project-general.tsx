import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useProjects, useWorkspaceConfig } from '@/api/queries'
import type { Capabilities, ProjectListEntry } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { useActiveProjectId } from '@/lib/project-router'
import { ProjectFolderField } from './project-location'
import { MaxParallelSelect, STATUS_LABEL } from './projects-section'
import { RemoveProjectDialog, useProjectRemoval } from './remove-project'
import { SettingsField } from './settings-field'

/**
 * Project settings → General: what THIS project is, and the few knobs that belong to the project
 * as a whole rather than to agents, worktrees or templates.
 *
 * It exists because every other section answers a narrow question and none of them answered the
 * broad one. Where is this checkout? Is its folder still there? How many of its tasks may run at
 * once? How do I get rid of it? Those last two lived only in the GLOBAL registry table — a row
 * in a list of every project, reached from the other settings area — which is a strange place to
 * go to act on the project you are already inside.
 *
 * Two things are deliberately NOT duplicated here: anything machine-wide (appearance, host
 * resources, accounts — the index's footer links to Global settings for those), and the section
 * list, which is the left nav on desktop and only renders as cards on small screens.
 *
 * Reuse over restatement: the folder row, the concurrency select, and the removal wording+dialog
 * are the same components the registry table uses. Two pages disagreeing about what "Remove"
 * does is exactly the failure this page could otherwise introduce.
 *
 * Split in two halves, because `CEZ_SINGLE_PROJECT=1` treats them differently. DESCRIBING the
 * project (folder, registry facts) stays true in every mode. MANAGING the registry — the
 * concurrency ceiling, Remove — is what single-project mode takes away: `PATCH`/`DELETE
 * /api/v1/projects/:id` both answer 409 there (server.ts), and `visibleSettingsSections` already
 * drops the whole global Projects section for the same reason. Rendering those two fields anyway
 * would offer a knob that can only fail, which is the opposite of what capabilities.ts asks for
 * ("the UI hides what the server says isn't there, and the matching endpoints refuse as defense
 * in depth").
 */

/** `2026-07-20T…` → a full local date. Unlike the registry table's compact `Jul 20`, this page has
 *  the room and is the place someone comes to check WHEN. An unparseable stamp degrades to an em
 *  dash rather than `Invalid Date`. */
function fullDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ProjectGeneral({ capabilities }: { capabilities?: Pick<Capabilities, 'singleProject'> }) {
  const projectId = useActiveProjectId()
  const projects = useProjects()
  const config = useWorkspaceConfig()

  if (projects.isPending) {
    return (
      <p data-slot="project-general-loading" className="text-[13px] text-soft-foreground">
        Loading project…
      </p>
    )
  }
  // An unreadable registry is SAID, not skipped. Defense in depth rather than a path a user
  // reaches today: `ProjectScopeRoute` keeps a scoped URL on "Loading…" while the registry query
  // is unresolved, so this branch only renders where the gate is not in front of it. It belongs
  // here anyway — on desktop the section cards are `md:hidden` (the left nav already lists them),
  // so a silent `null` would leave the whole pane blank with no hint that anything went wrong.
  if (projects.isError) {
    return (
      <p data-slot="project-general-error" className="text-[13px] text-danger">
        Could not read the project registry — {projects.error.message}
      </p>
    )
  }
  const registry = projects.data
  const project = registry?.projects.find((entry) => entry.id === projectId)
  // No registry entry for this URL (an unscoped mount, or an id the registry does not have):
  // there is nothing true to say about a project that isn't one.
  if (!registry || !project) return null
  // See the header comment: single-project mode keeps the description, drops the management.
  const managesRegistry = capabilities?.singleProject !== true

  return (
    <div data-slot="project-general" className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <ProjectFolderField />
      <ProjectFacts project={project} canRemove={managesRegistry} />
      {managesRegistry ? (
        <>
          <SettingsField
            title="Max parallel tasks"
            hint={
              config.data
                ? `How many of this project's tasks may run at once. The workspace limit (${config.data.resources.maxParallel}) still applies as an overall ceiling, so a higher value here has no extra effect until that one is raised.`
                : "How many of this project's tasks may run at once. The workspace limit still applies as an overall ceiling."
            }
          >
            {config.data ? (
              <MaxParallelSelect project={project} workspaceMax={config.data.resources.maxParallel} />
            ) : (
              // The select's "Inherit workspace (N)" option has to name N, and guessing it would be
              // the one thing this control must not do.
              <p className="text-[13px] text-soft-foreground">Loading the workspace limit…</p>
            )}
          </SettingsField>
          <RemoveProject project={project} bootProject={registry.bootProject} />
        </>
      ) : null}
    </div>
  )
}

/** The registry entry, read out: what cezar probed about this folder the last time it looked.
 *  `canRemove` is whether the Remove field is rendered below — the missing-folder hint points at
 *  it, and must not point at a field single-project mode took away. */
function ProjectFacts({ project, canRemove }: { project: ProjectListEntry; canRemove: boolean }) {
  return (
    <SettingsField
      title="Project"
      hint="The registry entry for this checkout — re-probed every time the project list is read."
    >
      <dl
        data-slot="project-facts"
        className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-card p-3 text-[13px]"
      >
        <dt className="text-muted-foreground">Name</dt>
        <dd className="min-w-0 truncate text-foreground">{project.name}</dd>

        <dt className="text-muted-foreground">Status</dt>
        <dd data-slot="project-general-status" className={project.status === 'missing' ? 'text-danger' : 'text-foreground'}>
          {STATUS_LABEL[project.status]}
          {/* A registered folder that has been deleted or moved is the one status worth acting
              on, and "folder not found" alone does not say what to do about it. */}
          {project.status === 'missing'
            ? canRemove
              ? ' — remove it below, or restore the folder'
              : ' — restore the folder at the path above'
            : null}
        </dd>

        {/* Omitted rather than dashed when git could not name one (unborn HEAD): an empty row
            invites the reader to wonder which branch is checked out, a missing row does not. */}
        {project.branch !== undefined ? (
          <>
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="min-w-0 truncate font-mono text-xs text-foreground">{project.branch}</dd>
          </>
        ) : null}

        <dt className="text-muted-foreground">Added</dt>
        <dd className="text-foreground">
          {fullDate(project.addedAt)}
          <span className="text-soft-foreground">
            {project.source === 'checkout' ? ' · cloned from GitHub' : ' · opened locally'}
          </span>
        </dd>

        <dt className="text-muted-foreground">Last opened</dt>
        <dd className="text-foreground">{fullDate(project.lastOpenedAt)}</dd>
      </dl>
    </SettingsField>
  )
}

/**
 * Deregister this project — the registry table's per-row Remove, offered where the user already
 * is. Same hook, same dialog, same words (remove-project.tsx).
 *
 * The boot project cannot be removed: cezar is serving it and re-registers it at every start, so
 * the server 409s. Disabling here means the explanation arrives before the click rather than as
 * an error toast after it.
 *
 * On success the URL this page lives at (`/p/<id>/settings`) has just stopped resolving, so the
 * navigation is part of the action, not a nicety. It targets the BOOT project explicitly rather
 * than `/`: the bare root restores the last saved location, and whether the removed project has
 * already left the registry cache when that check runs is a race — this is the one project that
 * is always registered.
 */
function RemoveProject({ project, bootProject }: { project: ProjectListEntry; bootProject: string }) {
  const [confirming, setConfirming] = useState<ProjectListEntry | null>(null)
  const remove = useProjectRemoval()
  const navigate = useNavigate()
  const isBoot = project.id === bootProject

  return (
    <SettingsField
      title="Remove from workspace"
      hint="Unregisters this project so it leaves the sidebar and the project list. Nothing on disk is deleted — the folder, its git history and its task history all stay, and opening it again re-registers it."
    >
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="project-general-remove"
          // Leads with the words on the button (WCAG 2.5.3 Label in Name) so speech input can
          // reach it, then says what "Remove" actually does — the row context that makes a bare
          // "Remove" safe-sounding isn't read out with it.
          aria-label={`Remove ${project.name} from the workspace — unregisters it, no files are deleted`}
          title={isBoot ? 'cezar is serving this project — it re-registers itself at every start' : undefined}
          disabled={isBoot || remove.isPending}
          onClick={() => setConfirming(project)}
          className="text-danger"
        >
          Remove {project.name}
        </Button>
        {isBoot ? (
          <span data-slot="project-general-remove-boot" className="text-[11px] text-soft-foreground">
            cezar is serving this project — it re-registers itself at every start.
          </span>
        ) : null}
      </div>
      <RemoveProjectDialog
        project={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={() => {
          setConfirming(null)
          // A 409 (running tasks) leaves the project registered, so the navigation is inside the
          // success path only — `useProjectRemoval` toasts the server's refusal and stays put.
          remove.confirm(project, () => void navigate(`/p/${encodeURIComponent(bootProject)}`))
        }}
      />
    </SettingsField>
  )
}

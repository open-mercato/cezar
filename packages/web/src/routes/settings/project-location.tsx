import { useMutation } from '@tanstack/react-query'
import { CopyIcon } from 'lucide-react'

import { openProjectIn } from '@/api/client'
import { useOpenTargets, useProjects } from '@/api/queries'
import { OpenInMenu, cliTargetRunner } from '@/components/open-in-menu'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { useActiveProjectId } from '@/lib/project-router'
import { SettingsFact } from './settings-field'

/**
 * "Where is this project?" — the active project's absolute root, inside project settings.
 *
 * Settings is the one place a user goes to ask what a project IS, and the answer to the most
 * basic question ("which folder on disk?") used to live only in the GLOBAL registry table, one
 * area away and listing every project rather than this one. The path shown here is the registry's
 * `root`: absolute and realpath-normalized, the same string the server resolves worktrees and git
 * commands against, so it can be pasted straight into a terminal.
 *
 * Two renderings, both from this file so they cannot drift:
 *  - `ProjectFolderField` — the General dashboard's row: the path WRAPPED rather than truncated
 *    (seeing all of it is the point), plus the two things a user wants it for — Copy, and
 *    "Open with" (this machine's editors, file manager and terminal, via `POST /api/v1/open-in`);
 *  - `ProjectLocationNav` — the desktop section nav's footer, the project-scope twin of the
 *    global nav's "Stored in ~/.cezar": one truncated line that keeps the answer on every section.
 *
 * Both render NOTHING when the root is unknown (registry still loading, or an unscoped mount): a
 * placeholder path is worse than no path, and the registry answer arrives within a tick anyway.
 */

/** The active project's absolute root, or `null` while the registry cannot name it. */
export function useActiveProjectRoot(): string | null {
  const projectId = useActiveProjectId()
  const registry = useProjects().data
  if (projectId === null) return null
  return registry?.projects.find((project) => project.id === projectId)?.root ?? null
}

/** Copy that survives a denied/absent clipboard: the fallback toast still shows the full path,
 *  so the user can select it by hand instead of being told nothing happened. */
function copyPath(root: string) {
  void navigator.clipboard
    .writeText(root)
    .then(() => toast('Project folder copied'))
    .catch(() => toast(root))
}

export function ProjectFolderField() {
  const root = useActiveProjectRoot()
  if (root === null) return null
  return (
    <SettingsFact label="Folder">
      <div data-slot="project-location" data-variant="field" className="flex flex-col gap-2">
        {/* `break-all`, not `truncate`: a deep checkout path is exactly the case this row exists
            for, and half of it is not an answer. */}
        <span data-slot="project-location-path" className="font-mono text-[13px] break-all text-foreground">
          {root}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="project-location-copy"
            title="Copy the project folder path"
            onClick={() => copyPath(root)}
          >
            <CopyIcon aria-hidden="true" className="size-3.5" />
            Copy path
          </Button>
          <OpenWithMenu root={root} />
        </div>
      </div>
    </SettingsFact>
  )
}

export function ProjectLocationNav() {
  const root = useActiveProjectRoot()
  if (root === null) return null
  return (
    <div data-slot="project-location" data-variant="nav" className="px-2.5">
      <p className="text-xs text-soft-foreground">Project folder</p>
      <button
        type="button"
        data-action="project-location-copy"
        title={`${root} — click to copy`}
        onClick={() => copyPath(root)}
        className="block w-full truncate text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        // Keep the END of the path visible: the folder name is the part that tells projects apart.
        style={{ direction: 'rtl' }}
      >
        <bdi>{root}</bdi>
      </button>
    </div>
  )
}

/**
 * "Open with" — the project folder in the editor, file manager or terminal this machine has.
 *
 * The list is the machine's detected apps MINUS the `cli:<runner>` handoffs: those start an agent
 * session in whatever folder they are given, and every task deliberately runs in a worktree
 * instead of the checkout. The server refuses them too (400) — this filter is so the menu never
 * offers a pick that can only fail.
 *
 * Renders nothing when there is nothing to offer: hosted mode (`CEZ_REMOTE`) answers with an
 * empty target list, and a menu whose every item is missing is worse than no menu.
 */
function OpenWithMenu({ root }: { root: string }) {
  const targets = useOpenTargets()
  const open = useMutation({
    mutationFn: (target: string) => openProjectIn(target),
    // The server's own words — "no such app on this machine: …", "could not open …".
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const choices = (targets.data?.targets ?? [])
    .filter((target) => cliTargetRunner(target.id) === undefined)
    .map((target) => ({ target }))
  if (choices.length === 0) return null
  return (
    <OpenInMenu
      slot="project-location-open"
      label="Open with"
      triggerVariant="outline"
      title={root}
      disabled={open.isPending}
      choices={choices}
      // An app launches detached and may take seconds to paint its window — without a word here
      // a slow editor reads as a dead button, so the pick is acknowledged by name.
      onPick={(target) =>
        open.mutate(target, {
          onSuccess: () =>
            toast(`Opening the project folder in ${choices.find((c) => c.target.id === target)?.target.label ?? target}`),
        })
      }
    />
  )
}

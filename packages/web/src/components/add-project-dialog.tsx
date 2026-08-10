import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useProjects, useRegisterProject } from '@/api/queries'
import type { FsBrowseDir } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FolderBrowser, useBrowseTarget } from '@/components/folder-browser'

/**
 * "Add project → Open local folder" (multi-project spec, "Add project" / step 4.2).
 *
 * Registers the folder chosen in the shared `FolderBrowser` with `POST /api/v1/projects`, then
 * navigates to the new project's scope. The browsing itself — and the three API shapes it is
 * faithful to — lives in `components/folder-browser.tsx`, shared with "Add agent account".
 *
 * A non-git folder is selectable: `isRepo` only earns a badge, because cezar degrades in a
 * non-git folder exactly as `cezar serve` does today, so gating selection on it would invent a
 * restriction the server does not have.
 *
 * The register errors (a home directory, hosted-mode narrowing) are shown VERBATIM: the server
 * writes them for the person reading them, and this dialog cannot know which of them is the
 * user's real situation.
 */
export function AddProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // `null` = the independently configured browse root. The dialog never spells that path itself
  // — it only ever echoes what it was told.
  const [path, setPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<FsBrowseDir | null>(null)
  const projects = useProjects()
  const register = useRegisterProject()
  const navigate = useNavigate()

  // Registry roots are realpath'd server-side; a listed `path` may be a symlink's own spelling,
  // so this match is best-effort — it decorates a row, it never blocks one. (A duplicate is not
  // an error anyway: the 409 carries the existing entry and we navigate to it.)
  const registered = new Set((projects.data?.projects ?? []).map((project) => project.root))

  const enter = (dir: string) => {
    setPath(dir)
    setSelected(null)
    register.reset() // a stale "that folder is your home directory" must not haunt the next one
  }

  // Nothing selected means "add the folder I am looking at" — the mockup's footer path. That is
  // also the only way to add the browse root itself.
  const target = useBrowseTarget(path, selected)

  const add = () => {
    if (target === null || register.isPending) return
    register.mutate(target, {
      onSuccess: ({ project }) => {
        onOpenChange(false)
        // Raw react-router `useNavigate`, not the scope-aware wrapper: this is a deliberate
        // cross-project jump, and `/p/…` targets pass through the wrapper untouched anyway.
        navigate(`/p/${encodeURIComponent(project.id)}/`)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="add-project-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open local folder</DialogTitle>
          <DialogDescription>
            Pick the folder cezar should run in. Git repos are marked; any folder works.
          </DialogDescription>
        </DialogHeader>

        <FolderBrowser
          path={path}
          selected={selected}
          onSelect={setSelected}
          onEnter={enter}
          emptyHint="No subfolders here — “Add project” registers this folder."
          decorate={(dir) => (
            <>
              {dir.isRepo ? (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  git
                </Badge>
              ) : null}
              {registered.has(dir.path) ? (
                <Badge variant="ghost" className="shrink-0 text-[10px] text-muted-foreground">
                  already added
                </Badge>
              ) : null}
            </>
          )}
        />

        {register.isError ? (
          <p data-slot="add-project-error" className="min-w-0 break-words text-[13px] text-danger">
            {register.error instanceof Error ? register.error.message : 'could not add that folder'}
          </p>
        ) : null}

        {/* min-w-0 matters: DialogContent is a grid, and a grid item with visible overflow
            cannot shrink below its min-content — a long target path (unbreakable, mono) would
            widen the whole column and push every row past the card edge. With the floor removed
            the path truncates instead. */}
        <DialogFooter className="min-w-0 sm:items-center sm:justify-between">
          <span
            data-slot="add-project-target"
            className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground"
            title={target ?? undefined}
          >
            {target ?? ''}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              data-slot="add-project-confirm"
              disabled={target === null || register.isPending}
              onClick={add}
            >
              {register.isPending ? 'Adding…' : 'Add project'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

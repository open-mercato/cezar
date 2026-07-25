import { ChevronRightIcon, CornerLeftUpIcon, FolderIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useFsBrowse, useProjects, useRegisterProject } from '@/api/queries'
import type { FsBrowseDir } from '@/api/types'
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
import { cn } from '@/lib/utils'

/**
 * "Add project → Open local folder" (multi-project spec, "Add project" / step 4.2).
 *
 * Browses the server's filesystem through `GET /api/fs/browse` and registers the chosen folder
 * with `POST /api/projects`, then navigates to the new project's scope.
 *
 * Three shapes of the API this dialog is deliberately faithful to, because each one is a place
 * a picker usually lies:
 *
 * - **`parent === null` means the browse root.** No "up" row is rendered there — the root's
 *   parent is not part of the surface, and a row that 400s is worse than no row.
 * - **`truncated`** is surfaced as a visible note. A silently short listing in a huge directory
 *   would read as "the folder isn't there".
 * - **A non-git folder is selectable.** `isRepo` only earns a badge; cezar degrades in a
 *   non-git folder exactly as `cezar serve` does today, so gating selection on it would invent
 *   a restriction the server does not have.
 *
 * The browse errors (400 outside the root, 404 gone) and the register errors (a home directory,
 * hosted-mode narrowing) are shown VERBATIM: the server writes them for the person reading
 * them, and this dialog cannot know which of them is the user's real situation.
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
  const listing = useFsBrowse(path)
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
  const target = selected?.path ?? listing.data?.path ?? null
  /** `null` at the browse root (and while loading) — the "up" row exists only when it leads
   *  somewhere the server is willing to list. */
  const parent = listing.data?.parent ?? null

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

        {/* The breadcrumb is the server's realpath'd answer, not the spelling we asked for. */}
        <p
          data-slot="fs-breadcrumb"
          className="truncate font-mono text-[11.5px] text-soft-foreground"
          title={listing.data?.path ?? undefined}
        >
          {listing.data?.path ?? (listing.isError ? '' : 'Loading…')}
        </p>

        {listing.isError ? (
          <p data-slot="fs-error" className="text-[13px] text-danger">
            {listing.error instanceof Error ? listing.error.message : 'could not list that folder'}
          </p>
        ) : (
          <ul
            data-slot="fs-listing"
            className="max-h-64 divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-md border border-border"
          >
            {/* Only when the server said there IS a parent — at the root there is no up. */}
            {parent !== null ? (
              <li className="flex">
                <button
                  type="button"
                  data-slot="fs-up"
                  onClick={() => enter(parent)}
                  className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted"
                >
                  <CornerLeftUpIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  Up one level
                </button>
              </li>
            ) : null}
            {(listing.data?.dirs ?? []).map((dir) => (
              <li key={dir.path} className="flex items-stretch">
                <button
                  type="button"
                  data-slot="fs-dir"
                  aria-pressed={selected?.path === dir.path}
                  onClick={() => setSelected(dir)}
                  onDoubleClick={() => enter(dir.path)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted',
                    selected?.path === dir.path && 'bg-muted',
                  )}
                >
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{dir.name}</span>
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
                </button>
                {/* Navigating IN is its own control rather than a click-to-enter row: the row
                    click has to stay "select this one", or the folder you actually want (the one
                    you can see) would be the one you cannot choose. Double-click enters too. */}
                <button
                  type="button"
                  data-slot="fs-enter"
                  aria-label={`Open ${dir.name}`}
                  onClick={() => enter(dir.path)}
                  className="flex shrink-0 items-center px-2.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
            {listing.data && listing.data.dirs.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-muted-foreground">
                No subfolders here — “Add project” registers this folder.
              </li>
            ) : null}
          </ul>
        )}

        {listing.data?.truncated ? (
          <p data-slot="fs-truncated" className="text-[11.5px] text-muted-foreground">
            Too many folders to list — only the first ones are shown.
          </p>
        ) : null}

        {register.isError ? (
          <p data-slot="add-project-error" className="text-[13px] text-danger">
            {register.error instanceof Error ? register.error.message : 'could not add that folder'}
          </p>
        ) : null}

        <DialogFooter className="sm:items-center sm:justify-between">
          <span
            data-slot="add-project-target"
            className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground"
            title={target ?? undefined}
          >
            {target ?? ''}
          </span>
          <span className="flex gap-2">
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

import { FolderIcon, FolderPlusIcon, PlusIcon } from 'lucide-react'
import * as React from 'react'

import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { CreateProjectDialog } from '@/components/create-project-dialog'
import { DialogErrorBoundary } from '@/components/dialog-error-boundary'
import { GithubIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { trackAddProjectOpened } from '@/lib/telemetry'

/**
 * The "Add project" dropdown (multi-project spec, "Sidebar → Header"), now the project
 * switcher's footer. "Open local folder…" opens the folder browser (step 4.2), "Clone from
 * GitHub…" the checkout dialog (step 4.3), "New project…" the create dialog (spec
 * 2026-09-29-create-new-project).
 *
 * Not gh-gated here: the dialogs are mounted only while open, so a shell without a QueryClient
 * still renders the menu, and the degradation lands one click later with the server's own words.
 */
export function AddProjectMenu({ className }: { className?: string }) {
  const [browsing, setBrowsing] = React.useState(false)
  const [cloning, setCloning] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-slot="add-project" aria-label="Add project" className={className}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Add project
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-soft-foreground">Add project</DropdownMenuLabel>
        <DropdownMenuItem
          data-slot="add-project-local"
          onSelect={() => {
            setBrowsing(true)
            trackAddProjectOpened('folder')
          }}
        >
          <FolderIcon aria-hidden="true" />
          Open local folder…
        </DropdownMenuItem>
        <DropdownMenuItem
          data-slot="add-project-clone"
          onSelect={() => {
            setCloning(true)
            trackAddProjectOpened('clone')
          }}
        >
          <GithubIcon aria-hidden="true" />
          Clone from GitHub…
        </DropdownMenuItem>
        <DropdownMenuItem
          data-slot="add-project-create"
          onSelect={() => {
            setCreating(true)
            trackAddProjectOpened('new')
          }}
        >
          <FolderPlusIcon aria-hidden="true" />
          New project…
        </DropdownMenuItem>
      </DropdownMenuContent>
      {browsing ? (
        <DialogErrorBoundary label="Open local folder" onError={() => setBrowsing(false)}>
          <AddProjectDialog open onOpenChange={setBrowsing} />
        </DialogErrorBoundary>
      ) : null}
      {cloning ? (
        <DialogErrorBoundary label="Clone from GitHub" onError={() => setCloning(false)}>
          <CloneProjectDialog open onOpenChange={setCloning} />
        </DialogErrorBoundary>
      ) : null}
      {creating ? (
        <DialogErrorBoundary label="New project" onError={() => setCreating(false)}>
          <CreateProjectDialog open onOpenChange={setCreating} />
        </DialogErrorBoundary>
      ) : null}
    </DropdownMenu>
  )
}

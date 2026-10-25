import * as React from 'react'
import { FolderIcon } from 'lucide-react'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { ProjectFolder } from '@/lib/project-folders'

export function ProjectFolderDialog({
  projects,
  folder,
  onClose,
  onSave,
}: {
  projects: ProjectListEntry[]
  folder: ProjectFolder | null
  onClose: () => void
  onSave: (folder: ProjectFolder | null, previousId?: string) => void
}) {
  const [name, setName] = React.useState(folder?.name ?? '')
  const [selected, setSelected] = React.useState<string[]>(folder?.projectIds ?? [])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-slot="project-folder-dialog">
        <DialogHeader>
          <DialogTitle>{folder ? 'Organise folder' : 'Create project folder'}</DialogTitle>
          <DialogDescription>Group projects for a client or any other part of your work.</DialogDescription>
        </DialogHeader>
        <label className="grid gap-2 text-sm font-medium">Folder name
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Client name" />
        </label>
        <fieldset className="grid max-h-60 gap-1 overflow-y-auto">
          <legend className="mb-2 text-sm font-medium">Projects</legend>
          {projects.map((project) => (
            <label key={project.id} className="flex min-h-9 items-center gap-2 rounded px-2 text-sm hover:bg-muted">
              <input type="checkbox" checked={selected.includes(project.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} />
              <FolderIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />{project.name}
            </label>
          ))}
        </fieldset>
        <DialogFooter className="sm:justify-between">
          {folder ? <Button variant="danger-ghost" onClick={() => onSave(null, folder.id)}>Delete folder</Button> : <span />}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || selected.length === 0} onClick={() => onSave({ id: folder?.id ?? crypto.randomUUID(), name: name.trim(), projectIds: selected }, folder?.id)}>Save folder</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { LockIcon, SettingsIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router'

import { onWorkspaceEvent } from '@/api/global-events'
import { useCreateProject, useGithubOwners, useProjects } from '@/api/queries'
import type { CheckoutProgressEvent } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * "Add project → New project…" (spec 2026-09-29-create-new-project).
 *
 * A fresh git repository at `<projectsDir>/<name>`, and — when `gh` is signed in — a new GitHub
 * repository under the chosen account or organisation. The GitHub repository is ALWAYS private:
 * there is no visibility control here and the request has no field for one. Visibility is a
 * one-click change on GitHub; an accidentally public repository is not undoable.
 *
 * An optional template (`owner/repo` or a GitHub URL) generates the repository from a GitHub
 * template instead of starting empty.
 *
 * Same conventions as the clone dialog: progress is `checkout-progress` filtered to this
 * dialog's own id, and errors are the server's words, verbatim.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [useGithub, setUseGithub] = useState(true)
  const [owner, setOwner] = useState('')
  const [template, setTemplate] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const projects = useProjects()
  const owners = useGithubOwners()
  const create = useCreateProject()
  const navigate = useNavigate()

  const checkoutId = useMemo(() => `np-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`, [])
  const idRef = useRef(checkoutId)
  idRef.current = checkoutId

  useEffect(() => {
    return onWorkspaceEvent((eventName, payload) => {
      if (eventName !== 'checkout-progress') return
      const event = payload as CheckoutProgressEvent
      if (event?.checkoutId !== idRef.current) return
      if (event.phase === 'cloning' && event.line) setProgress(event.line)
      else if (event.phase !== 'cloning') setProgress(null)
    })
  }, [])

  const ownersData = owners.data
  const githubAvailable = ownersData?.available === true
  const ownerOptions = useMemo(
    () => (ownersData?.available ? [ownersData.login, ...ownersData.orgs.filter((o) => o !== ownersData.login)] : []),
    [ownersData],
  )
  const effectiveOwner = owner !== '' && ownerOptions.includes(owner) ? owner : (ownerOptions[0] ?? '')
  const github = useGithub && githubAvailable

  const trimmedName = name.trim()
  const projectsDir = projects.data?.projectsDir ?? ''
  const target = trimmedName === '' ? '' : `${projectsDir.replace(/\/+$/, '')}/${trimmedName}`

  const submit = () => {
    if (trimmedName === '' || create.isPending) return
    if (useGithub && owners.isPending) return
    setProgress(null)
    const trimmedTemplate = template.trim()
    create.mutate(
      {
        name: trimmedName,
        checkoutId,
        ...(github
          ? { github: { owner: effectiveOwner, ...(trimmedTemplate === '' ? {} : { template: trimmedTemplate }) } }
          : {}),
      },
      {
        onSuccess: ({ project }) => {
          onOpenChange(false)
          navigate(`/p/${encodeURIComponent(project.id)}/`)
        },
      },
    )
  }

  const busy = create.isPending

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent data-slot="create-project-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            cezar creates a new git repository in your checkout root and adds it as a project.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="create-name">Name</Label>
          <Input
            id="create-name"
            data-slot="create-name"
            autoFocus
            placeholder="my-project"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          <div className="flex min-w-0 items-center gap-1">
            <p
              data-slot="create-target"
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-soft-foreground"
              title={target}
            >
              {target}
            </p>
            {busy ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7"
                aria-label="Edit checkout root"
                title="Edit checkout root"
                disabled
              >
                <SettingsIcon className="size-3.5" aria-hidden="true" />
              </Button>
            ) : (
              <Button asChild variant="ghost" size="icon-sm" className="size-7">
                <RouterLink to="/settings/global/projects" aria-label="Edit checkout root" title="Edit checkout root">
                  <SettingsIcon className="size-3.5" aria-hidden="true" />
                </RouterLink>
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="create-github" className="flex items-center gap-1.5">
              <LockIcon className="size-3.5" aria-hidden="true" />
              Create a private GitHub repository
            </Label>
            <Switch
              id="create-github"
              data-slot="create-github"
              checked={github}
              disabled={busy || !githubAvailable}
              onCheckedChange={setUseGithub}
            />
          </div>

          {owners.isPending ? (
            <p className="text-[12px] text-muted-foreground">Checking GitHub…</p>
          ) : ownersData && !ownersData.available ? (
            <p data-slot="create-github-unavailable" className="text-[12px] text-muted-foreground">
              {ownersData.reason}
            </p>
          ) : null}

          {github ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="create-owner">Owner</Label>
                <select
                  id="create-owner"
                  data-slot="create-owner"
                  value={effectiveOwner}
                  disabled={busy}
                  onChange={(event) => setOwner(event.target.value)}
                  className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  {ownerOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-template">Template (optional)</Label>
                <Input
                  id="create-template"
                  data-slot="create-template"
                  placeholder="owner/repo or https://github.com/owner/repo"
                  value={template}
                  disabled={busy}
                  onChange={(event) => setTemplate(event.target.value)}
                />
              </div>
              <p className="text-[12px] text-muted-foreground">
                The repository is created as <strong>private</strong> — you can change its visibility on GitHub.
              </p>
            </>
          ) : null}
        </div>

        {busy ? (
          <p data-slot="create-progress" className="truncate font-mono text-[11.5px] text-muted-foreground">
            {progress ?? 'Starting…'}
          </p>
        ) : null}

        {create.isError ? (
          <p data-slot="create-error" className="whitespace-pre-line text-[13px] text-danger">
            {create.error instanceof Error ? create.error.message : 'could not create the project'}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="create-confirm"
            disabled={trimmedName === '' || busy || (useGithub && owners.isPending)}
            onClick={submit}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

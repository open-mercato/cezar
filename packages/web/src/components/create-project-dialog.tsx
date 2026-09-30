import { CircleCheckIcon, LockIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { onWorkspaceEvent } from '@/api/global-events'
import { useCreateProject, useGithubOwners, useProjects } from '@/api/queries'
import { GITHUB_REPO_NAME_PATTERN, type CheckoutProgressEvent, type GithubOwner } from '@open-mercato/cezar-api-client'
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
import { cn } from '@/lib/utils'

/** Typing a space gives a dash, the way GitHub's own new-repository form suggests it: the name is
 *  the folder AND the repository, so it follows GitHub's naming rules from the first keystroke. */
function toRepoName(input: string): string {
  return input.trimStart().replace(/\s+/g, '-')
}

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
  const githubAvailable = ownersData?.available === true && Array.isArray(ownersData.owners) && ownersData.owners.length > 0
  const ownerOptions = useMemo(
    () => (ownersData?.available && Array.isArray(ownersData.owners) ? ownersData.owners : []),
    [ownersData],
  )
  // The personal account is first, so it is the default until the user picks an organisation.
  const effectiveOwner = ownerOptions.some((o) => o.login === owner) ? owner : (ownerOptions[0]?.login ?? '')
  const github = useGithub && githubAvailable

  const trimmedName = name.trim()
  const nameValid = GITHUB_REPO_NAME_PATTERN.test(trimmedName)
  const nameError =
    trimmedName === '' || nameValid
      ? null
      : trimmedName.length > 100
        ? 'At most 100 characters.'
        : 'Use letters, digits, “.”, “-” and “_” only.'
  const projectsDir = projects.data?.projectsDir ?? ''
  const target = nameValid ? `${projectsDir.replace(/\/+$/, '')}/${trimmedName}` : ''

  const submit = () => {
    if (!nameValid || create.isPending) return
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
            aria-invalid={nameError !== null}
            aria-describedby="create-name-hint"
            onChange={(event) => setName(toRepoName(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          {nameError ? (
            <p id="create-name-hint" data-slot="create-name-error" className="text-[12px] text-danger">
              {nameError}
            </p>
          ) : (
            <p
              id="create-name-hint"
              data-slot="create-target"
              className="min-w-0 truncate font-mono text-[11.5px] text-soft-foreground"
              title={target}
            >
              {target}
            </p>
          )}
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
          ) : !githubAvailable ? (
            <p data-slot="create-github-unavailable" className="text-[12px] text-muted-foreground">
              {ownersData && !ownersData.available
                ? ownersData.reason
                : 'Could not read your GitHub accounts — the project will be created locally only.'}
            </p>
          ) : null}

          {github ? (
            <>
              <OwnerPicker owners={ownerOptions} value={effectiveOwner} disabled={busy} onChange={setOwner} />
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
            disabled={!nameValid || busy || (useGithub && owners.isPending)}
            onClick={submit}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The owner cards: avatar, login, and "Personal account" or the organisation's description, the
 * selected one outlined and checked. A radio group — arrow keys move between cards, the way a
 * native `<select>` would have.
 */
function OwnerPicker({
  owners,
  value,
  disabled,
  onChange,
}: {
  owners: GithubOwner[]
  value: string
  disabled: boolean
  onChange: (login: string) => void
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (from: number, delta: number) => {
    if (owners.length === 0) return
    const next = (from + delta + owners.length) % owners.length
    const login = owners[next]?.login
    if (login === undefined) return
    onChange(login)
    refs.current[next]?.focus()
  }
  return (
    <div className="grid gap-1.5">
      <span id="create-owner-label" className="text-sm font-medium">
        Owner
      </span>
      <div
        role="radiogroup"
        aria-labelledby="create-owner-label"
        data-slot="create-owner"
        className="-mx-1 grid max-h-64 gap-2 overflow-y-auto px-1 py-0.5"
      >
        {owners.map((o, index) => {
          const selected = o.login === value
          return (
            <button
              key={o.login}
              ref={(el) => {
                refs.current[index] = el
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              data-slot="create-owner-option"
              data-owner={o.login}
              onClick={() => onChange(o.login)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  move(index, 1)
                } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                  event.preventDefault()
                  move(index, -1)
                }
              }}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left outline-none transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
                selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
              )}
            >
              <OwnerAvatar owner={o} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex items-center gap-1.5 truncate text-sm font-semibold">
                  {o.login}
                  {selected ? <CircleCheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
                </span>
                {o.personal ? (
                  <span className="text-[12px] text-muted-foreground">Personal account</span>
                ) : o.description ? (
                  <span className="line-clamp-2 text-[12px] text-muted-foreground">{o.description}</span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A 36 px avatar with a letter fallback — never a broken-image glyph. Organisations are rounded
 *  squares and people are circles, as on GitHub. */
function OwnerAvatar({ owner }: { owner: GithubOwner }) {
  const [failed, setFailed] = useState(false)
  const shape = owner.personal ? 'rounded-full' : 'rounded-md'
  if (owner.avatarUrl && !failed) {
    return (
      <img
        src={owner.avatarUrl}
        alt=""
        width={36}
        height={36}
        loading="lazy"
        onError={() => setFailed(true)}
        data-slot="create-owner-avatar"
        className={cn('size-9 shrink-0 bg-muted', shape)}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center bg-muted text-sm font-semibold text-muted-foreground uppercase',
        shape,
      )}
    >
      {owner.login.slice(0, 1)}
    </span>
  )
}

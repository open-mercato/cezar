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
import { GithubTemplateInput } from '@/components/github-template-input'
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
 * "Start with" is an explicit choice: an empty repository (one empty initial commit), or — with
 * GitHub on — a GitHub template (`owner/repo`, a URL, or one of the suggested templates).
 *
 * Same conventions as the clone dialog: progress is `checkout-progress` filtered to this
 * dialog's own id, and errors are the server's words, verbatim.
 */
export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('')
  const [useGithub, setUseGithub] = useState(true)
  const [owner, setOwner] = useState('')
  const [template, setTemplate] = useState('')
  const [start, setStart] = useState<'empty' | 'template'>('empty')
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
  const githubAvailable =
    ownersData?.available === true && Array.isArray(ownersData.owners) && ownersData.owners.length > 0
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

  // A template is a GitHub feature (`gh repo create --template`), so it applies only with GitHub on.
  const fromTemplate = github && start === 'template'
  const templateMissing = fromTemplate && template.trim() === ''

  const submit = () => {
    if (!nameValid || create.isPending) return
    if (useGithub && owners.isPending) return
    if (templateMissing) return
    setProgress(null)
    const trimmedTemplate = template.trim()
    create.mutate(
      {
        name: trimmedName,
        checkoutId,
        ...(github
          ? {
              github: {
                owner: effectiveOwner,
                ...(fromTemplate && trimmedTemplate !== '' ? { template: trimmedTemplate } : {}),
              },
            }
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

  // Two columns from `md` up — the owner cards on the left, the form on the right — whenever
  // there are owners to pick (or they are still loading, so the layout does not jump when they
  // arrive). Without GitHub the dialog is the single-column form. Below `md` it all stacks.
  const showOwners = owners.isPending || githubAvailable

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        data-slot="create-project-dialog"
        className={cn(
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          // Desktop: a FIXED height, header/body/footer rows, each column scrolling on its own —
          // so choosing "From a template", filtering the list or a long org list never resizes
          // (and so never re-centres and shifts) the dialog.
          showOwners
            ? 'md:h-[min(50rem,calc(100dvh-4rem))] md:max-w-3xl md:grid-rows-[auto_minmax(0,1fr)_auto] md:overflow-hidden'
            : undefined,
        )}
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            cezar creates a new git repository in your checkout root and adds it as a project.
          </DialogDescription>
        </DialogHeader>

        <div
          data-slot="create-layout"
          className={cn(
            'grid gap-6',
            showOwners ? 'md:min-h-0 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]' : undefined,
          )}
        >
          {showOwners ? (
            <div
              data-slot="create-owners-column"
              className="min-w-0 md:flex md:min-h-0 md:flex-col md:border-r md:border-border md:pr-6"
            >
              {githubAvailable ? (
                <OwnerPicker
                  owners={ownerOptions}
                  value={effectiveOwner}
                  disabled={busy || !github}
                  onChange={setOwner}
                />
              ) : (
                <OwnerPickerLoading />
              )}
            </div>
          ) : null}

          <div
            data-slot="create-form-column"
            className={cn(
              'grid min-w-0 content-start gap-4',
              showOwners ? 'md:-m-1 md:flex md:min-h-0 md:flex-col md:overflow-y-auto md:p-1' : undefined,
            )}
          >
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
                <p className="text-[12px] text-muted-foreground">
                  Created as <strong>private</strong> under <strong>{effectiveOwner}</strong> — you can change its
                  visibility on GitHub.
                </p>
              ) : null}
            </div>

            <div
              data-slot="create-start"
              className="grid gap-3 rounded-md border border-border p-3 md:flex md:min-h-0 md:flex-1 md:flex-col"
            >
              <span id="create-start-label" className="text-sm font-medium">
                Start with
              </span>
              <div role="radiogroup" aria-labelledby="create-start-label" className="grid gap-2 sm:grid-cols-2">
                <StartOption
                  slot="create-start-empty"
                  checked={!fromTemplate}
                  disabled={busy}
                  title="Empty repository"
                  hint="One empty commit, no files."
                  onSelect={() => setStart('empty')}
                />
                <StartOption
                  slot="create-start-template"
                  checked={fromTemplate}
                  disabled={busy || !github}
                  title="From a template"
                  hint={github ? 'Copy a GitHub template.' : 'Needs a GitHub repository.'}
                  onSelect={() => setStart('template')}
                />
              </div>
              {fromTemplate ? (
                <div className="grid gap-1.5 md:flex md:min-h-0 md:flex-1 md:flex-col">
                  <Label htmlFor="create-template">Template</Label>
                  <GithubTemplateInput id="create-template" value={template} disabled={busy} onChange={setTemplate} />
                </div>
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
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="create-confirm"
            disabled={!nameValid || busy || templateMissing || (useGithub && owners.isPending)}
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
    <div className="grid gap-3 md:flex md:min-h-0 md:flex-1 md:flex-col">
      <span
        id="create-owner-label"
        className="text-[12px] font-semibold tracking-wider text-muted-foreground uppercase"
      >
        Select organization
      </span>
      <div
        role="radiogroup"
        aria-labelledby="create-owner-label"
        data-slot="create-owner"
        className="-mx-1 grid max-h-64 content-start gap-2 overflow-y-auto px-1 py-0.5 md:max-h-none md:min-h-0 md:flex-1"
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

/** One of the two "Start with" choices — a radio rendered as a small card. */
function StartOption({
  slot,
  checked,
  disabled,
  title,
  hint,
  onSelect,
}: {
  slot: string
  checked: boolean
  disabled: boolean
  title: string
  hint: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      data-slot={slot}
      onClick={onSelect}
      className={cn(
        'grid gap-0.5 rounded-md border px-3 py-2 text-left outline-none transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-[12px] text-muted-foreground">{hint}</span>
    </button>
  )
}

/** Placeholder cards while `gh` is asked for the accounts, so the column does not pop in. */
function OwnerPickerLoading() {
  return (
    <div className="grid gap-3" data-slot="create-owners-loading" aria-hidden="true">
      <span className="text-[12px] font-semibold tracking-wider text-muted-foreground uppercase">
        Select organization
      </span>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <span className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="h-3 w-24 animate-pulse rounded bg-muted" />
        </div>
      ))}
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

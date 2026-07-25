import { SettingsIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router'

import { onWorkspaceEvent } from '@/api/global-events'
import { useCheckoutProject, useProjects } from '@/api/queries'
import type { CheckoutProgressEvent } from '@/api/types'
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

/**
 * "Add project → Clone from GitHub" (multi-project spec, "Add project" option B / step 4.3).
 *
 * The mockup's three parts, and what each one is faithful to:
 *
 * - **The repo input** takes `owner/repo` or any GitHub URL spelling. It is NOT validated here
 *   beyond "non-empty": the server parses it with the one parser that also decides what `gh`
 *   is handed, and a second, looser copy in the browser would only disagree with it.
 * - **The target preview** (`<projectsDir>/<name>`) is assembled from the registry response's
 *   `projectsDir` plus the editable name. It is a preview of the server's own composition rule,
 *   which is why the name defaults to the repo half of whatever was typed.
 * - **Progress** is the `checkout-progress` stream, filtered to THIS dialog's `checkoutId`.
 *   Without it a clone of a large repo is an indistinguishable-from-hung spinner for minutes.
 *
 * Errors are shown verbatim (`{ error }`): a clone fails for reasons — `gh` missing, not
 * authenticated, no such repo, target folder exists, DNS down — that only the server can name,
 * and paraphrasing them into "could not clone" is exactly the silent-spinner failure this
 * dialog exists to avoid.
 */
export function CloneProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const projects = useProjects()
  const checkout = useCheckoutProject()
  const navigate = useNavigate()

  // One id per mounted dialog. The dialog is mounted only while open (AddProjectMenu), so a
  // second clone attempt in a second opening is a second id — which is the point: a stale
  // event from an abandoned clone must never drive this one's progress line.
  const checkoutId = useMemo(() => `co-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`, [])

  // Kept in a ref, not state: the listener below must read the CURRENT id without re-subscribing
  // (a resubscribe per render would drop events between teardown and setup).
  const idRef = useRef(checkoutId)
  idRef.current = checkoutId

  useEffect(() => {
    return onWorkspaceEvent((eventName, payload) => {
      if (eventName !== 'checkout-progress') return
      const event = payload as CheckoutProgressEvent
      if (event?.checkoutId !== idRef.current) return
      // `error` is surfaced through the mutation's own rejection (the response carries it too),
      // so the terminal phases only stop the progress line rather than racing it.
      if (event.phase === 'cloning' && event.line) setProgress(event.line)
      else if (event.phase !== 'cloning') setProgress(null)
    })
  }, [])

  /** The repo half of whatever was typed, used as the default folder name. Deliberately naive —
   *  it mirrors the server's default, and the server re-derives it anyway when `name` is blank. */
  const derivedName = useMemo(() => {
    const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
    const last = cleaned.split('/').pop() ?? ''
    return last.includes(':') ? (last.split(':').pop() ?? '') : last
  }, [url])
  const effectiveName = name.trim() === '' ? derivedName : name.trim()

  const projectsDir = projects.data?.projectsDir ?? ''
  const target = effectiveName === '' ? '' : `${projectsDir.replace(/\/+$/, '')}/${effectiveName}`

  const clone = () => {
    if (url.trim() === '' || checkout.isPending) return
    setProgress(null)
    checkout.mutate(
      { url: url.trim(), checkoutId, ...(name.trim() === '' ? {} : { name: name.trim() }) },
      {
        onSuccess: ({ project }) => {
          onOpenChange(false)
          // Raw react-router `useNavigate`, not the scope-aware wrapper — a deliberate
          // cross-project jump, exactly as the folder-browser dialog does.
          navigate(`/p/${encodeURIComponent(project.id)}/`)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (checkout.isPending ? undefined : onOpenChange(next))}>
      <DialogContent data-slot="clone-project-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone from GitHub</DialogTitle>
          <DialogDescription>
            cezar clones with <code>gh</code> into your checkout root and adds the result as a project.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="clone-url">Repository</Label>
          <Input
            id="clone-url"
            data-slot="clone-url"
            autoFocus
            placeholder="owner/repo or https://github.com/owner/repo"
            value={url}
            disabled={checkout.isPending}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') clone()
            }}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="clone-name">Folder name</Label>
          <Input
            id="clone-name"
            data-slot="clone-name"
            placeholder={derivedName === '' ? 'repo' : derivedName}
            value={name}
            disabled={checkout.isPending}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex min-w-0 items-center gap-1">
            <p
              data-slot="clone-target"
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-soft-foreground"
              title={target}
            >
              {target}
            </p>
            {checkout.isPending ? (
              <Button
                data-slot="clone-root-settings"
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
                <RouterLink
                  to="/settings/global/projects"
                  data-slot="clone-root-settings"
                  aria-label="Edit checkout root"
                  title="Edit checkout root"
                >
                  <SettingsIcon className="size-3.5" aria-hidden="true" />
                </RouterLink>
              </Button>
            )}
          </div>
        </div>

        {/* One line, replaced in place: `git clone` emits a counter update every few hundred ms,
            and a growing log would scroll a dialog that is otherwise a form. */}
        {checkout.isPending ? (
          <p data-slot="clone-progress" className="truncate font-mono text-[11.5px] text-muted-foreground">
            {progress ?? 'Starting the clone…'}
          </p>
        ) : null}

        {checkout.isError ? (
          <p data-slot="clone-error" className="text-[13px] text-danger">
            {checkout.error instanceof Error ? checkout.error.message : 'could not clone that repository'}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={checkout.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="clone-confirm"
            disabled={url.trim() === '' || effectiveName === '' || checkout.isPending}
            onClick={clone}
          >
            {checkout.isPending ? 'Cloning…' : 'Clone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

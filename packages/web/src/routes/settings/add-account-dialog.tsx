import { useState } from 'react'

import { useCreateAgentProfile } from '@/api/queries'
import type { FsBrowseDir, ProviderId } from '@open-mercato/cezar-api-client'
import { FolderBrowser } from '@/components/folder-browser'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'

/**
 * "Add agent account" (spec 2026-07-29-agent-profiles): point a provider at a second config
 * folder, so a work login can sit beside a personal one.
 *
 * **The typed path is the source of truth, not the browser selection.** Two reasons, and both are
 * disqualifying for a browse-only picker:
 *
 * 1. every candidate is a dotfolder (`~/.claude-second`), and a folder that does not exist yet
 *    cannot be browsed to at all — yet that is the normal case, because the documented flow is
 *    *add the account → Connect → the CLI creates the folder on login*;
 * 2. `GET /api/v1/fs/browse` is refused in single-project mode and is rooted at the configured
 *    browse root, so a browse-only field would make the whole feature unreachable for anyone
 *    whose accounts live outside it.
 *
 * The browser is therefore an assist that fills the field, and it asks for hidden folders because
 * otherwise it could not show a single real candidate. cezar still does not go LOOKING for
 * accounts — see the spec's "no globbing": a folder is an account because the user said so.
 *
 * Validation stays server-side (absolute after `~` expansion, not already another account's
 * folder, no control characters); this dialog only refuses an empty field, because that is not a
 * request worth sending.
 */
export function AddAccountDialog({
  open,
  onOpenChange,
  providers,
  initialProvider,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Providers that can carry more than one account — the server decides, not this dialog. */
  providers: ProviderId[]
  /** Which agent's "Add account" was clicked; still switchable in the dialog. */
  initialProvider?: ProviderId
}) {
  // `null` = the configured browse root. The dialog never spells that path itself.
  const [path, setPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<FsBrowseDir | null>(null)
  const [provider, setProvider] = useState<ProviderId>(initialProvider ?? providers[0] ?? 'claude')
  const [label, setLabel] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const create = useCreateAgentProfile()

  const trimmed = configDir.trim()

  const enter = (dir: string) => {
    setPath(dir)
    setSelected(null)
    create.reset() // a stale "already used by …" must not haunt the next folder
  }

  /** Browsing writes into the field; the field is what gets submitted. */
  const take = (dir: FsBrowseDir) => {
    setSelected(dir)
    setConfigDir(dir.path)
    create.reset()
  }

  const add = () => {
    if (trimmed === '' || create.isPending) return
    create.mutate(
      { provider, configDir: trimmed, ...(label.trim() ? { label: label.trim() } : {}) },
      {
        onSuccess: () => {
          onOpenChange(false)
          setLabel('')
          setConfigDir('')
          setSelected(null)
          setBrowsing(false)
          toast('Account added — use Connect to sign in')
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="add-account-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add agent account</DialogTitle>
          <DialogDescription>
            The config folder this account uses. It does not have to exist yet — Connect signs in
            and the CLI creates it.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field>
              <FieldLabel htmlFor="add-account-provider">Agent</FieldLabel>
              <Select value={provider} onValueChange={(value) => setProvider(value as ProviderId)}>
                <SelectTrigger id="add-account-provider" aria-label="Agent" data-slot="add-account-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="add-account-label">Name</FieldLabel>
              <Input
                id="add-account-label"
                type="text"
                aria-label="Account name"
                data-slot="add-account-label"
                value={label}
                placeholder="Work"
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="add-account-dir">Config folder</FieldLabel>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                id="add-account-dir"
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label="Config folder"
                data-slot="add-account-dir"
                value={configDir}
                placeholder={provider === 'codex' ? '~/.codex-second' : '~/.claude-second'}
                onChange={(event) => {
                  setConfigDir(event.target.value)
                  setSelected(null)
                  create.reset()
                }}
                className="min-w-0 flex-1 font-mono text-[13px] md:text-[13px]"
              />
              <Button
                type="button"
                variant="outline"
                data-action="add-account-browse"
                aria-expanded={browsing}
                onClick={() => setBrowsing((on) => !on)}
              >
                {browsing ? 'Hide folders' : 'Browse…'}
              </Button>
            </div>
            <FieldDescription className="text-xs">
              A <code className="font-mono">~</code> is kept as written and expanded when the agent runs.
            </FieldDescription>
          </Field>
        </FieldGroup>

        {/* Collapsed by default: typing (or pasting) the path is the fast path, and browsing to a
            folder that does not exist yet is impossible anyway. */}
        {browsing ? (
          <FolderBrowser
            path={path}
            selected={selected}
            onSelect={take}
            onEnter={enter}
            // Every agent config folder is hidden — without this the listing shows none of them.
            showHidden
            emptyHint="No subfolders here — pick this folder by typing its path above."
          />
        ) : null}

        {/* The server's own words: "that is already this agent's default folder", "already used
            by …", "must be an absolute path". This dialog cannot know which applies. */}
        {create.isError ? (
          <p data-slot="add-account-error" role="alert" className="min-w-0 text-[13px] break-words text-danger">
            {create.error instanceof Error ? create.error.message : 'could not add that folder'}
          </p>
        ) : null}

        <DialogFooter className="min-w-0 sm:items-center sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="default"
            data-slot="add-account-confirm"
            disabled={trimmed === '' || create.isPending}
            onClick={add}
          >
            {create.isPending ? 'Adding…' : 'Add account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

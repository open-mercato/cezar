import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { SECRET_AUDIENCES, secretNameIssue, type SecretAudience, type SecretsList } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import {
  removeProjectSecret, removeWorkspaceSecret, saveProjectSecret, saveWorkspaceSecret,
} from '@/api/client'
import { queryKeys, useProjectSecrets, useWorkspaceSecrets, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/** What each audience means to the person storing the secret. */
const AUDIENCE_LABELS: Record<SecretAudience, string> = {
  checks: 'Check steps (workflow commands)',
  cezar: 'cezar itself (its own features — not the agents)',
}

/** The backend line under the list: a file fallback is never silent. */
function keyBackendNote(keyBackend: SecretsList['keyBackend']): string {
  return keyBackend === 'keychain'
    ? 'Encrypted with a data key kept in your OS keychain.'
    : 'Encrypted with a data key in ~/.cezar/secrets/.key (0600) — no OS keychain is available on this machine, so this is a private file, not a vault.'
}

interface SecretsSectionProps {
  scope: 'project' | 'workspace'
  list: { data?: SecretsList; isPending: boolean; isError: boolean; error: Error | null }
  save: (name: string, input: { value: string; audiences: SecretAudience[] }) => Promise<void>
  remove: (name: string) => Promise<void>
  invalidate: (queryClient: ReturnType<typeof useQueryClient>, projectId: string | null) => Promise<void>
}

/**
 * Secrets (spec 2026-10-10-project-secrets-vault-options): metadata only. A stored value is never
 * fetched, shown or copyable; the form takes a value once and sends it. One component for both
 * scopes, parameterized by the queries and writers it uses.
 */
function SecretsSection({ scope, list, save, remove, invalidate }: SecretsSectionProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [audiences, setAudiences] = useState<SecretAudience[]>(['checks'])
  const [error, setError] = useState<string | null>(null)
  const nameIssue = name === '' ? null : secretNameIssue(name)

  const saving = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await save(name, { value, audiences }); return { projectId, saved: name } },
    onSuccess: async ({ projectId, saved }) => {
      if (queryScope() === projectId) { setName(''); setValue(''); setError(null) }
      await invalidate(queryClient, projectId)
      toast(`${saved} saved`)
    },
    // Keep the value on failure: it is already in component state either way, and clearing it
    // makes a transient 409 cost the user a re-paste of a 100-character key.
    onError: (e: Error) => setError(e.message),
  })
  const removing = useMutation({
    mutationFn: async (target: string) => { const projectId = queryScope(); await remove(target); return { projectId, removed: target } },
    onSuccess: async ({ projectId, removed }) => { await invalidate(queryClient, projectId); toast(`${removed} removed`) },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const submit = () => {
    const issue = secretNameIssue(name)
    if (issue) { setError(issue); return }
    if (audiences.length === 0) { setError('pick at least one audience'); return }
    setError(null)
    saving.mutate()
  }
  const toggleAudience = (audience: SecretAudience) =>
    setAudiences((current) => (current.includes(audience) ? current.filter((a) => a !== audience) : [...current, audience]))

  const title = scope === 'project' ? 'Project secrets' : 'Workspace secrets'
  const intro = scope === 'project'
    ? 'Values for this project only — an e2e runner’s model key, a staging login. They reach the audiences you pick and never an agent session.'
    : 'Values shared by every project on this machine — a key cezar’s own features use, a token every project’s checks need. A project secret of the same name wins. They never reach an agent session.'
  const secrets = list.data?.secrets ?? []

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6" data-slot="secrets-settings" data-scope={scope}>
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
        {list.isPending ? <p className="mt-4 text-sm text-muted-foreground">Loading…</p> : null}
        {list.isError ? <p role="alert" className="mt-4 text-sm text-danger">{list.error?.message}</p> : null}
        {list.data && secrets.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No secrets stored.</p> : null}
        {list.data && secrets.length > 0 ? (
          <ul className="mt-4 divide-y divide-border rounded-md border border-border" aria-label={`Stored ${scope} secrets`}>
            {secrets.map((stored) => (
              <li key={stored.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <code className="text-sm">{stored.name}</code>
                  <p className="text-xs text-muted-foreground">{stored.audiences.map((a) => AUDIENCE_LABELS[a].split(' (')[0]).join(' · ')}</p>
                </div>
                <Button variant="outline" aria-label={`Delete ${stored.name}`} disabled={removing.isPending} onClick={() => removing.mutate(stored.name)}>
                  <Trash2Icon className="size-3.5" /> Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {list.data ? <p className="mt-3 text-xs text-muted-foreground" data-slot="key-backend">{keyBackendNote(list.data.keyBackend)}</p> : null}
      </section>

      <form className="rounded-lg border border-border bg-card p-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <h2 className="text-sm font-semibold">Add or replace a secret</h2>
        <label className="mt-3 block text-sm">Name
          <input aria-label="Name" value={name} onChange={(event) => { setName(event.target.value.toUpperCase()); setError(null) }}
            autoComplete="off" spellCheck={false} placeholder="AI_GATEWAY_API_KEY" aria-invalid={nameIssue ? true : undefined}
            className="mt-1 block w-full rounded border border-border bg-background p-2 font-mono" />
        </label>
        {nameIssue ? <p className="mt-1 text-xs text-danger">{nameIssue}</p> : null}
        <label className="mt-3 block text-sm">Value
          <input aria-label="Value" type="password" autoComplete="off" required value={value} onChange={(event) => setValue(event.target.value)}
            className="mt-1 block w-full rounded border border-border bg-background p-2" />
        </label>
        <fieldset className="mt-3">
          <legend className="text-sm">Who may read it</legend>
          {SECRET_AUDIENCES.map((audience) => (
            <label key={audience} className="mt-1 flex items-center gap-2 text-sm">
              <input type="checkbox" aria-label={AUDIENCE_LABELS[audience]} checked={audiences.includes(audience)} onChange={() => toggleAudience(audience)} />
              {AUDIENCE_LABELS[audience]}
            </label>
          ))}
          <p className="mt-1 text-xs text-muted-foreground">Agents are never an audience: a secret cannot be handed to a Claude Code, Codex or OpenCode session.</p>
        </fieldset>
        {error && error !== nameIssue ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
        <div className="mt-3">
          <Button type="submit" disabled={saving.isPending || name === '' || value === '' || audiences.length === 0 || !!nameIssue}>Save secret</Button>
        </div>
      </form>
    </div>
  )
}

/** Settings → project → Secrets. */
export function ProjectSecretsSection() {
  const list = useProjectSecrets()
  return (
    <SecretsSection
      scope="project"
      list={list}
      save={saveProjectSecret}
      remove={removeProjectSecret}
      invalidate={(queryClient, projectId) => queryClient.invalidateQueries({ queryKey: queryKeys.secrets.allFor(projectId ?? '') })}
    />
  )
}

/** Settings → Global → Secrets. */
export function WorkspaceSecretsSection() {
  const list = useWorkspaceSecrets()
  return (
    <SecretsSection
      scope="workspace"
      list={list}
      save={saveWorkspaceSecret}
      remove={removeWorkspaceSecret}
      invalidate={(queryClient) => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.secrets })}
    />
  )
}

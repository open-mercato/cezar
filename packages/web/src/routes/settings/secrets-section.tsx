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
import { LoadingState, RowsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard } from './form-row'

/** What each audience means to the person storing the secret. */
const AUDIENCE_LABELS: Record<SecretAudience, string> = {
  checks: 'Check steps (workflow commands)',
  cezar: 'cezar itself (its own features — not the agents)',
}

/** The short form for the table's "Visible to" column. */
const audienceSummary = (audiences: readonly SecretAudience[]) =>
  audiences.map((a) => AUDIENCE_LABELS[a].split(' (')[0]).join(' · ')

/** The backend line under the list: a file fallback is never silent. */
function keyBackendNote(keyBackend: SecretsList['keyBackend']): string {
  return keyBackend === 'keychain'
    ? 'Encrypted with a data key kept in your OS keychain.'
    : 'Encrypted with a data key in ~/.cezar/secrets/.key (0600) — no OS keychain is available on this machine, so this is a private file, not a vault.'
}

const inputClass =
  'mt-1 block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

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
 * scopes, parameterized by the queries and writers it uses. The table says who may read each
 * secret in one "Visible to" column (design doc, Proposal 8).
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
    <div className="flex w-full flex-col gap-5" data-slot="secrets-settings" data-scope={scope}>
      <SettingsCard title={title} description={intro}>
        {list.isPending ? <LoadingState label="Loading secrets…" className="p-4"><RowsSkeleton rows={2} /></LoadingState> : null}
        {list.isError ? <p role="alert" className="px-4 py-3 text-sm text-danger">{list.error?.message}</p> : null}
        {list.data && secrets.length === 0 ? <CardNote>No secrets stored.</CardNote> : null}
        {list.data && secrets.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-ui" aria-label={`Stored ${scope} secrets`}>
              <thead>
                <tr className="border-b border-border text-left text-label text-soft-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2 font-medium">Visible to</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((stored) => (
                  <tr key={stored.name} data-slot="secret-row" data-name={stored.name} className="border-b border-border last:border-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal"><code className="text-sm">{stored.name}</code></th>
                    <td className="px-4 py-2 text-muted-foreground">{audienceSummary(stored.audiences)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" aria-label={`Delete ${stored.name}`} disabled={removing.isPending} onClick={() => removing.mutate(stored.name)}>
                        <Trash2Icon className="size-3.5" /> Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {list.data?.skipped ? <p role="alert" className="px-4 py-2 text-meta text-danger" data-slot="secrets-skipped">Stored values cannot be read: {list.data.skipped}.</p> : null}
        {list.data ? <CardNote slot="key-backend">{keyBackendNote(list.data.keyBackend)}</CardNote> : null}

        <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <FormRow
            stacked
            label="Add or replace a secret"
            description="Agents are never an audience: a secret cannot be handed to a Claude Code, Codex or OpenCode session."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui">Name
                <input aria-label="Name" value={name} onChange={(event) => { setName(event.target.value.toUpperCase()); setError(null) }}
                  autoComplete="off" spellCheck={false} placeholder="AI_GATEWAY_API_KEY" aria-invalid={nameIssue ? true : undefined}
                  className={`${inputClass} font-mono`} />
              </label>
              <label className="block text-ui">Value
                <input aria-label="Value" type="password" autoComplete="off" required value={value} onChange={(event) => setValue(event.target.value)}
                  className={inputClass} />
              </label>
            </div>
            {nameIssue ? <p className="text-meta text-danger">{nameIssue}</p> : null}
            <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <legend className="mb-1 text-ui">Visible to</legend>
              {SECRET_AUDIENCES.map((audience) => (
                <label key={audience} className="flex items-center gap-2 text-ui">
                  <input type="checkbox" aria-label={AUDIENCE_LABELS[audience]} checked={audiences.includes(audience)} onChange={() => toggleAudience(audience)} />
                  {AUDIENCE_LABELS[audience]}
                </label>
              ))}
            </fieldset>
            {error && error !== nameIssue ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
            <div>
              <Button type="submit" size="sm" disabled={saving.isPending || name === '' || value === '' || audiences.length === 0 || !!nameIssue}>Save secret</Button>
            </div>
          </FormRow>
        </form>
      </SettingsCard>
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

/** Settings → Data & privacy → Workspace secrets. */
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

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PencilIcon, Trash2Icon } from 'lucide-react'
import { useRef, useState } from 'react'

import { secretNameIssue, type SecretAudience, type SecretBinding, type SecretEntry, type SecretsList } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import {
  removeProjectSecret, removeWorkspaceSecret, saveProjectSecret, saveWorkspaceSecret,
} from '@/api/client'
import { queryKeys, useProjectSecrets, useWorkspaceSecrets, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard } from './form-row'
import {
  EMPTY_BINDING_FIELDS, FILE_KEY_PROXY_NOTE, bindingSummary, fieldsOf, keyBackendNote, parseBinding, usageSummary,
  type BindingFields,
} from './secrets-binding'
import { SecretBindingFields } from './secrets-binding-fields'

interface SecretsSectionProps {
  scope: 'project' | 'workspace'
  list: { data?: SecretsList; isPending: boolean; isError: boolean; error: Error | null }
  save: (name: string, input: { value: string; audiences: SecretAudience[]; binding?: SecretBinding }) => Promise<void>
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
    const [fields, setFields] = useState<BindingFields>(EMPTY_BINDING_FIELDS)
  const [editing, setEditing] = useState<{ name: string; legacy: boolean } | null>(null)
  const valueInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const nameIssue = name === '' ? null : secretNameIssue(name)

  const saving = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await save(name, { value, audiences: ['proxy'], binding: parseBinding(fields).binding }); return { projectId, saved: name } },
    onSuccess: async ({ projectId, saved }) => {
      if (queryScope() === projectId) { resetForm() }
      await invalidate(queryClient, projectId)
      toast(`${saved} saved`)
    },
    // Keep the value on failure: it is already in component state either way, and clearing it
    // makes a transient 409 cost the user a re-paste of a 100-character key.
    onError: (e: Error) => setError(e.message),
  })
  const resetForm = () => { setName(''); setValue(''); setFields(EMPTY_BINDING_FIELDS); setEditing(null); setError(null) }
  const startEdit = (stored: SecretEntry) => {
    setName(stored.name)
    setValue('')
    setFields(stored.binding ? fieldsOf(stored.binding) : EMPTY_BINDING_FIELDS)
    setEditing({ name: stored.name, legacy: !stored.binding })
    setError(null)
    valueInput.current?.focus()
  }
  const removing = useMutation({
    mutationFn: async (target: string) => { const projectId = queryScope(); await remove(target); return { projectId, removed: target } },
    onSuccess: async ({ projectId, removed }) => { await invalidate(queryClient, projectId); toast(`${removed} removed`) },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const submit = () => {
    const issue = secretNameIssue(name)
    if (issue) { setError(issue); return }
    const { issue: bindingIssue } = parseBinding(fields)
    if (bindingIssue) { setError(bindingIssue); return }
    setError(null)
    saving.mutate()
  }
  const title = scope === 'project' ? 'Project secrets' : 'Workspace secrets'
  const intro = scope === 'project'
    ? 'Values for this project only — an e2e runner’s model key, a staging login. Each is sent only to the hosts you name, through the proxy, and never reaches an agent session.'
    : 'Values shared by every project on this machine — a key cezar’s own features use, a token every project’s checks need. A project secret of the same name wins. Each is sent only to the hosts you name, through the proxy, and never reaches an agent session.'
  const secrets = list.data?.secrets ?? []

  return (
    <div className="flex w-full flex-col gap-5" data-slot="secrets-settings" data-scope={scope}>
      <SettingsCard title={title} description={intro}>
        {list.isPending ? <LoadingState label="Loading secrets…" className="p-4"><RowsSkeleton rows={2} /></LoadingState> : null}
        {list.isError ? <p role="alert" className="px-4 py-3 text-ui text-danger">{list.error?.message}</p> : null}
        {list.data && secrets.length === 0 ? <CardNote>No secrets stored.</CardNote> : null}
        {list.data && secrets.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-ui" aria-label={`Stored ${scope} secrets`}>
              <thead>
                <tr className="border-b border-border text-left text-label text-soft-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2 font-medium">Sent to</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((stored) => (
                  <tr key={stored.name} data-slot="secret-row" data-name={stored.name} className="border-b border-border last:border-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal"><code className="font-mono text-ui">{stored.name}</code></th>
                    <td className="px-4 py-2 text-muted-foreground">
                      {stored.binding
                        ? <span className="font-mono text-meta" data-slot="secret-binding">{bindingSummary(stored.binding)}</span>
                        : usageSummary(stored.audiences)}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <Button variant="ghost" size="xs" aria-label={stored.binding ? `Edit ${stored.name}` : `Convert ${stored.name} to a proxy secret`} onClick={() => startEdit(stored)}>
                        <PencilIcon /> {stored.binding ? 'Edit' : 'Convert'}
                      </Button>
                      <Button variant="danger-ghost" size="xs" aria-label={`Delete ${stored.name}`} disabled={removing.isPending} onClick={() => removing.mutate(stored.name)}>
                        <Trash2Icon /> Delete
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
        {list.data?.keyBackend === 'file' ? <CardNote slot="key-backend-proxy">{FILE_KEY_PROXY_NOTE}</CardNote> : null}

        <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <FormRow
            stacked
            label="Add or replace a secret"
            description="Every secret goes through the proxy to the hosts you name; an agent session never sees the value."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui">Name
                <Input aria-label="Name" value={name} onChange={(event) => { setName(event.target.value.toUpperCase()); setError(null) }}
                  autoComplete="off" spellCheck={false} placeholder="AI_GATEWAY_API_KEY" readOnly={!!editing} aria-invalid={nameIssue ? true : undefined}
                  className="mt-1 h-8 font-mono text-ui" />
              </label>
              <label className="block text-ui">Value
                <Input ref={valueInput} aria-label="Value" type="password" autoComplete="off" required value={value} onChange={(event) => setValue(event.target.value)}
                  className="mt-1 h-8" />
              </label>
            </div>
            {nameIssue ? <p className="text-meta text-danger">{nameIssue}</p> : null}
            {editing ? (
              <p className="text-meta text-soft-foreground" data-slot="secret-editing">
                {editing.legacy
                  ? `Converting ${editing.name} to a proxy secret: name the hosts and re-enter the value. Until you save, it stays readable by its current consumers.`
                  : `Editing ${editing.name}: the value is never shown, so re-enter it; saving replaces the stored secret and its destinations.`}
              </p>
            ) : null}
            <SecretBindingFields fields={fields} onChange={(next) => { setFields(next); setError(null) }} />
            {error && error !== nameIssue ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
            <div>
              <Button type="submit" size="sm" disabled={saving.isPending || name === '' || value === '' || !!nameIssue || fields.hosts.trim() === ''}>Save secret</Button>
              {editing ? <Button type="button" variant="ghost" size="sm" className="ml-2" onClick={resetForm}>Cancel</Button> : null}
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

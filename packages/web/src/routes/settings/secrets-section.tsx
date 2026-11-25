import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import {
  SECRET_AUDIENCES, SECRET_BINDING_SCHEMES, secretBindingSchema, secretNameIssue,
  type SecretAudience, type SecretBinding, type SecretBindingScheme, type SecretsList,
} from '@open-mercato/cezar-api-client'
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

/** What each audience means to the person storing the secret. */
const AUDIENCE_LABELS: Record<SecretAudience, string> = {
  checks: 'Check steps (workflow commands)',
  cezar: 'cezar itself (its own features — not the agents)',
  proxy: 'Outbound proxy (injected into requests to the hosts you name)',
}

const FORM_AUDIENCES = SECRET_AUDIENCES

const bindingSummary = (binding: SecretBinding) =>
  `${binding.hosts.join(', ')} · ${binding.header} (${binding.scheme})${binding.sentinel ? ` · $${binding.sentinel}` : ''}`

/** The form's text fields → a binding, or the first reason there is none. */
function parseBinding(hosts: string, header: string, scheme: SecretBindingScheme, sentinel: string): { binding?: SecretBinding; issue?: string } {
  const parsed = secretBindingSchema.safeParse({
    hosts: [...new Set(hosts.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))].sort(),
    header: header.trim(),
    scheme,
    ...(sentinel.trim() ? { sentinel: sentinel.trim() } : {}),
  })
  return parsed.success ? { binding: parsed.data } : { issue: parsed.error.issues[0]?.message ?? 'invalid binding' }
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
  const [audiences, setAudiences] = useState<SecretAudience[]>(['checks'])
  const [hosts, setHosts] = useState('')
  const [header, setHeader] = useState('Authorization')
  const [scheme, setScheme] = useState<SecretBindingScheme>('bearer')
  const [sentinel, setSentinel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const isProxy = audiences.includes('proxy')
  const nameIssue = name === '' ? null : secretNameIssue(name)

  const saving = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await save(name, { value, audiences, ...(isProxy ? { binding: parseBinding(hosts, header, scheme, sentinel).binding } : {}) }); return { projectId, saved: name } },
    onSuccess: async ({ projectId, saved }) => {
      if (queryScope() === projectId) { setName(''); setValue(''); setHosts(''); setSentinel(''); setError(null) }
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
    if (isProxy) {
      const { issue } = parseBinding(hosts, header, scheme, sentinel)
      if (issue) { setError(issue); return }
    }
    setError(null)
    saving.mutate()
  }
  const toggleAudience = (audience: SecretAudience) =>
    setAudiences((current) => {
      if (audience === 'proxy') return current.includes('proxy') ? ['checks'] : ['proxy']
      const others = current.filter((a) => a !== 'proxy')
      return others.includes(audience) ? others.filter((a) => a !== audience) : [...others, audience]
    })

  const title = scope === 'project' ? 'Project secrets' : 'Workspace secrets'
  const intro = scope === 'project'
    ? 'Values for this project only — an e2e runner’s model key, a staging login. They reach the audiences you pick and never an agent session.'
    : 'Values shared by every project on this machine — a key cezar’s own features use, a token every project’s checks need. A project secret of the same name wins. They never reach an agent session.'
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
                  <th scope="col" className="px-4 py-2 font-medium">Visible to</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((stored) => (
                  <tr key={stored.name} data-slot="secret-row" data-name={stored.name} className="border-b border-border last:border-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal"><code className="font-mono text-ui">{stored.name}</code></th>
                    <td className="px-4 py-2 text-muted-foreground">
                      {audienceSummary(stored.audiences)}
                      {stored.binding ? <span className="block font-mono text-meta" data-slot="secret-binding">{bindingSummary(stored.binding)}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
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

        <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <FormRow
            stacked
            label="Add or replace a secret"
            description="Agents are never an audience: a secret cannot be handed to a Claude Code, Codex or OpenCode session."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui">Name
                <Input aria-label="Name" value={name} onChange={(event) => { setName(event.target.value.toUpperCase()); setError(null) }}
                  autoComplete="off" spellCheck={false} placeholder="AI_GATEWAY_API_KEY" aria-invalid={nameIssue ? true : undefined}
                  className="mt-1 h-8 font-mono text-ui" />
              </label>
              <label className="block text-ui">Value
                <Input aria-label="Value" type="password" autoComplete="off" required value={value} onChange={(event) => setValue(event.target.value)}
                  className="mt-1 h-8" />
              </label>
            </div>
            {nameIssue ? <p className="text-meta text-danger">{nameIssue}</p> : null}
            <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <legend className="mb-1 text-ui">Visible to</legend>
              {FORM_AUDIENCES.map((audience) => (
                <label key={audience} className="flex items-center gap-2 text-ui">
                  <input type="checkbox" aria-label={AUDIENCE_LABELS[audience]} checked={audiences.includes(audience)} onChange={() => toggleAudience(audience)} />
                  {AUDIENCE_LABELS[audience]}
                </label>
              ))}
            </fieldset>
            {isProxy ? (
              <div className="grid gap-3 sm:grid-cols-2" data-slot="secret-binding-form">
                <label className="block text-ui sm:col-span-2">Hosts (comma or space separated, exact, https only)
                  <Input aria-label="Hosts" value={hosts} onChange={(event) => { setHosts(event.target.value); setError(null) }}
                    autoComplete="off" spellCheck={false} placeholder="api.github.com, github.com" className="mt-1 h-8 font-mono text-ui" />
                </label>
                <label className="block text-ui">Header
                  <Input aria-label="Header" value={header} onChange={(event) => { setHeader(event.target.value); setError(null) }}
                    autoComplete="off" spellCheck={false} className="mt-1 h-8 font-mono text-ui" />
                </label>
                <label className="block text-ui">Scheme
                  <select aria-label="Scheme" value={scheme} onChange={(event) => setScheme(event.target.value as SecretBindingScheme)}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-ui">
                    {SECRET_BINDING_SCHEMES.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <label className="block text-ui sm:col-span-2">Placeholder env var (optional — what the sandbox sees instead of the value)
                  <Input aria-label="Placeholder env var" value={sentinel} onChange={(event) => { setSentinel(event.target.value.toUpperCase()); setError(null) }}
                    autoComplete="off" spellCheck={false} placeholder="GH_TOKEN" className="mt-1 h-8 font-mono text-ui" />
                </label>
                <p className="text-meta text-soft-foreground sm:col-span-2">Changing hosts, header or scheme means re-entering the value — it is stored sealed to its destinations.</p>
              </div>
            ) : null}
            {error && error !== nameIssue ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
            <div>
              <Button type="submit" size="sm" disabled={saving.isPending || name === '' || value === '' || audiences.length === 0 || !!nameIssue || (isProxy && hosts.trim() === '')}>Save secret</Button>
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

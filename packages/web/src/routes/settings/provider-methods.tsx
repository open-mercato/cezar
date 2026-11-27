import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { providerBaseUrlSchema, type AgentProviderEntry, type AgentProviderMethod } from '@open-mercato/cezar-api-client'
import { refreshProviderMethod, removeProviderMethod, saveProviderMethod, setActiveMethod } from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Only the editor's DOM holds the typed credential. Never put it in query/mutation cache or drafts. */
export function ProviderMethods({ agent, editable, subscription }: {
  agent: AgentProviderEntry
  editable: boolean
  subscription?: ReactNode
}) {
  const client = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editedFile, setEditedFile] = useState<string>()
  const change = async (write: () => Promise<unknown>) => {
    if (!editable || busy) return
    setBusy(true)
    setError('')
    try {
      await write()
      setEditing(null)
      await Promise.all([
        client.invalidateQueries({ queryKey: workspaceQueryKeys.agentProviders }),
        client.invalidateQueries({ queryKey: workspaceQueryKeys.models(agent.runner) }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Provider change failed')
    } finally {
      setBusy(false)
    }
  }
  const radio = agent.mode === 'one' && agent.methods.length > 1
  const firstSubscription = agent.methods.find(m => m.kind === 'subscription')
  return (
    <div>
      <h3 className="mb-2 text-label font-medium">Auth methods</h3>
      <div role={radio ? 'radiogroup' : 'group'} aria-label={`${agent.runner} auth methods`} className="space-y-1.5">
        {agent.methods.map(method => {
          const selected = agent.mode === 'any' ? method.state === 'connected' : agent.active === method.id
          const stored = Boolean(method.origin && method.origin !== 'host') || !!method.keyHint || method.state === 'error'
          const writable = editable && method.origin !== 'host' && method.kind !== 'subscription'
          const keyUrl = method.kind === 'openrouter' ? 'https://openrouter.ai/keys'
            : method.kind !== 'apiKey' ? undefined : agent.runner === 'gemini' ? 'https://aistudio.google.com/apikey'
            : agent.runner === 'cursor' ? 'https://cursor.com/dashboard' : undefined
          return (
            <div key={method.id} className={cn('rounded-md border border-border p-2.5', selected && 'border-primary/30 bg-primary/5')}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {radio && <input type="radio" name={`method-${agent.runner}`} checked={selected}
                  aria-label={`Run ${agent.runner} on ${method.label}`}
                  disabled={!editable || busy || method.state !== 'connected'}
                  onChange={() => void change(() => setActiveMethod(agent.runner, method.id))} />}
                <div className="min-w-0 flex-1 text-ui">
                  <strong className="font-medium">{method.label}</strong>
                  <div className="break-words text-label text-muted-foreground">
                    {method.state === 'connected' ? selected ? 'In use' : 'Connected, not in use'
                      : method.state === 'unknown' ? 'Login unverified' : method.state === 'error' ? 'Models unavailable' : 'Not connected'}
                    {method.origin === 'host' && ' · from host environment'}
                    {method.origin === 'file' && ' · from providers file'}
                    {method.baseUrl && ` · ${method.baseUrl}`}
                    {method.keyHint && ` · ${method.keyHint}`}
                    {method.modelCount !== undefined && ` · ${method.modelCount} models${method.error ? ' (stale)' : ''}`}
                  </div>
                </div>
                {method.error && <span className="text-label text-danger">{method.error}</span>}
                {writable && (method.state === 'error' || method.error) &&
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(() => refreshProviderMethod(agent.runner, method.id))}>Retry</Button>}
                {writable && !stored && keyUrl && <a href={keyUrl} target="_blank" rel="noreferrer" className="text-label underline">Get a key</a>}
                {writable && editing !== method.id && <>
                  <Button size="sm" variant="outline" disabled={busy} aria-label={`${stored ? 'Edit' : 'Add'} ${method.label} for ${agent.runner}`}
                    onClick={() => { setError(''); setEditing(method.id) }}>{stored ? method.kind === 'custom' ? 'Edit' : 'Replace key' : 'Add'}</Button>
                  {stored && <Button size="sm" variant="danger-ghost" disabled={busy} aria-label={`Remove ${method.label} for ${agent.runner}`}
                    onClick={() => void change(() => removeProviderMethod(agent.runner, method.id))}>Remove</Button>}
                </>}
              </div>
              {writable && editing === method.id &&
                <MethodEditor method={method} stored={stored} busy={busy} cancel={() => setEditing(null)}
                  save={(label, baseUrl, apiKey) => void change(async () => {
                    await saveProviderMethod(agent.runner, method.id, { kind: method.kind, ...(label && { label }), ...(baseUrl && { baseUrl }), ...(apiKey && { apiKey }) })
                    if (method.origin === 'file') setEditedFile(method.id)
                  })} />}
              {(editedFile === method.id || (editing === method.id && method.origin === 'file')) &&
                <p className="mt-2 text-label text-muted-foreground">The next <code>serve --providers</code> start overwrites this edit.</p>}
              {method === firstSubscription && subscription}
            </div>
          )
        })}
      </div>
      {error && <p role="alert" className="mt-2 text-label text-danger">{error}</p>}
    </div>
  )
}

function MethodEditor({ method, stored, busy, cancel, save }: {
  method: AgentProviderMethod
  stored: boolean
  busy: boolean
  cancel: () => void
  save: (label: string, baseUrl: string, apiKey: string) => void
}) {
  return (
    <form className="mt-3 grid gap-2 text-label" onSubmit={event => {
      event.preventDefault()
      const form = event.currentTarget
      const data = new FormData(form)
      const url = String(data.get('baseUrl') ?? '').trim()
      if (method.kind === 'custom' && !providerBaseUrlSchema.safeParse(url).success) {
        const input = form.elements.namedItem('baseUrl') as HTMLInputElement
        input.setCustomValidity('Use HTTPS or a loopback HTTP URL without credentials, query or fragment.')
        input.reportValidity()
        return
      }
      save(String(data.get('label') ?? '').trim(), url, String(data.get('apiKey') ?? ''))
    }}>
      {method.kind === 'custom' && <>
        <label>Name<Input name="label" required maxLength={120} defaultValue={stored ? method.label : ''} placeholder="Company gateway" /></label>
        <label>Base URL<Input name="baseUrl" required type="url" defaultValue={method.baseUrl} placeholder="https://llm.example.com"
          onChange={event => event.currentTarget.setCustomValidity('')} /></label>
      </>}
      <label>API key<Input type="password" name="apiKey" required={!stored} maxLength={16384} autoComplete="new-password"
        placeholder={stored ? 'Leave empty to keep the saved key' : undefined} /></label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save provider'}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Button>
      </div>
    </form>
  )
}

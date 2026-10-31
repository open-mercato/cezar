import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CableIcon } from 'lucide-react'
import { useState } from 'react'
import type { z } from 'zod'

import {
  AI_GATEWAY_AUTH_MODES,
  AI_GATEWAY_PROTOCOLS,
  normalizeAiGatewayBaseUrl,
  normalizeAiGatewayName,
  type AiGatewayAuthMode,
  type AiGatewayProtocol,
  type AiGatewayView,
  type createAiGatewaySchema,
} from '@open-mercato/cezar-api-client'
import { createAiGateway, removeAiGateway, updateAiGateway } from '@/api/client'
import { useAiGateways, workspaceQueryKeys } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

const PROTOCOL_LABELS: Record<AiGatewayProtocol, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
}

const AUTH_LABELS: Record<AiGatewayAuthMode, string> = {
  bearer: 'Bearer token',
  'x-api-key': 'x-api-key header',
}

const INTERRUPTED = 'Update interrupted — save the API key again or remove this gateway.'
const selectStyle = 'h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

interface Draft {
  id?: string
  pendingWrite?: boolean
  hasApiKey: boolean
  name: string
  baseUrl: string
  protocols: AiGatewayProtocol[]
  authProtocols: Partial<Record<AiGatewayProtocol, AiGatewayAuthMode>>
  catalog: AiGatewayAuthMode
  apiKey: string
  enabled: boolean
}

function emptyDraft(): Draft {
  return {
    hasApiKey: false,
    name: '',
    baseUrl: '',
    protocols: ['openai-responses'],
    authProtocols: { 'openai-responses': 'bearer' },
    catalog: 'bearer',
    apiKey: '',
    enabled: false,
  }
}

function draftFrom(gateway: AiGatewayView): Draft {
  return {
    id: gateway.id,
    pendingWrite: gateway.pendingWrite,
    hasApiKey: gateway.hasApiKey,
    name: gateway.name,
    baseUrl: gateway.baseUrl,
    protocols: [...gateway.protocols],
    authProtocols: { ...gateway.auth.protocols },
    catalog: gateway.auth.catalog,
    apiKey: '',
    enabled: gateway.enabled,
  }
}

/**
 * General settings → AI Gateways. ON means the connection is available, not that every task uses it.
 * A blank replacement key is omitted so the stored key stays. A pending row is not ready until the key is saved again.
 */
export function AiGatewaysSection() {
  const list = useAiGateways()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.aiGateways })
  const saving = useMutation({
    mutationFn: async (next: Draft) => {
      const body = gatewayBody(next)
      return next.id ? updateAiGateway(next.id, body) : createAiGateway(body)
    },
    onSuccess: async (saved) => {
      setDraft(null)
      setFormError(null)
      await refresh()
      toast(`${saved.name} saved`)
    },
    onError: (error: Error) => setFormError(error.message),
  })
  const toggling = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => updateAiGateway(input.id, { enabled: input.enabled }),
    onSuccess: async () => { setRowError(null); await refresh() },
    onError: (error: Error) => setRowError(error.message),
  })
  const removing = useMutation({
    mutationFn: (id: string) => removeAiGateway(id),
    onSuccess: async () => { setConfirmRemove(null); await refresh(); toast('Gateway removed') },
    onError: (error: Error) => setRowError(error.message),
  })

  if (list.isPending) {
    return <p className="p-4 text-[13px] text-soft-foreground md:p-6">Loading AI gateways…</p>
  }
  if (list.isError) {
    return (
      <CenteredState
        icon={<CableIcon />}
        tone="danger"
        title="AI gateways did not load"
        subtitle={list.error.message}
        heading="h2"
        actions={<Button type="button" onClick={() => void list.refetch()}>Retry</Button>}
      />
    )
  }

  const data = list.data
  const submit = () => {
    if (!draft) return
    const issue = draftIssue(draft)
    setFormError(issue)
    if (!issue) saving.mutate(draft)
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">AI Gateways</h2>
          <p className="text-[13px] text-muted-foreground">
            Connections a task can use. On means available. A task still uses the agent’s own login until you choose a gateway.
          </p>
        </div>
        <Button type="button" onClick={() => { setDraft(emptyDraft()); setFormError(null) }}>Add gateway</Button>
      </div>
      {data.registryError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2 text-[13px]">
          <span>{data.registryError}</span>
          <Button type="button" variant="outline" onClick={() => list.refetch()}>Retry</Button>
        </div>
      ) : null}
      {data.secretsSkipped ? <p className="text-[13px] text-muted-foreground">{data.secretsSkipped}</p> : null}
      {rowError ? <p role="alert" className="text-[13px] text-destructive">{rowError}</p> : null}
      {data.gateways.length === 0 && data.unavailable.length === 0 && !data.registryError ? (
        <p className="text-[13px] text-muted-foreground">No AI gateways yet.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {data.gateways.map((gateway) => (
          <li key={gateway.id} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{gateway.name}</p>
                <p className="truncate text-[12px] text-muted-foreground">{gateway.baseUrl}</p>
              </div>
              <Switch
                checked={gateway.enabled}
                disabled={gateway.pendingWrite === true || toggling.isPending}
                aria-label={`${gateway.name} on`}
                onCheckedChange={(enabled) => toggling.mutate({ id: gateway.id, enabled })}
              />
            </div>
            {gateway.pendingWrite ? <p className="text-[13px] text-destructive">{INTERRUPTED}</p> : null}
            {gateway.hasApiKey ? <p className="text-[12px] text-muted-foreground">API key saved</p> : <p className="text-[12px] text-muted-foreground">No API key yet</p>}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(draftFrom(gateway)); setFormError(null) }}>Edit {gateway.name}</Button>
              {confirmRemove === gateway.id ? (
                <Button type="button" variant="outline" size="sm" onClick={() => removing.mutate(gateway.id)}>Confirm remove {gateway.name}</Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRemove(gateway.id)}>Remove {gateway.name}</Button>
              )}
            </div>
          </li>
        ))}
        {data.unavailable.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <p className="text-[13px]">This gateway record is unreadable. Remove it and add it again.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => removing.mutate(row.id)}>Remove unreadable gateway</Button>
          </li>
        ))}
      </ul>
      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open) { setDraft(null); setFormError(null) } }}>
        {draft ? (
          <GatewayEditor
            draft={draft}
            error={formError}
            saving={saving.isPending}
            onChange={setDraft}
            onSubmit={submit}
            onClose={() => { setDraft(null); setFormError(null) }}
          />
        ) : null}
      </Dialog>
    </div>
  )
}

function draftIssue(draft: Draft): string | null {
  if (normalizeAiGatewayName(draft.name) === '') return 'A gateway needs a name.'
  if (normalizeAiGatewayBaseUrl(draft.baseUrl) === '') return 'A gateway needs an API base URL.'
  if (draft.protocols.length === 0) return 'Choose at least one API format.'
  if (draft.pendingWrite && draft.apiKey === '') return INTERRUPTED
  if (draft.enabled && !draft.hasApiKey && draft.apiKey === '') return 'An enabled gateway needs an API key.'
  return null
}

function gatewayBody(draft: Draft): z.input<typeof createAiGatewaySchema> {
  const protocols: Partial<Record<AiGatewayProtocol, AiGatewayAuthMode>> = {}
  for (const protocol of draft.protocols) protocols[protocol] = draft.authProtocols[protocol] ?? 'bearer'
  return {
    name: normalizeAiGatewayName(draft.name),
    baseUrl: normalizeAiGatewayBaseUrl(draft.baseUrl),
    protocols: draft.protocols,
    auth: { protocols, catalog: draft.catalog },
    enabled: draft.enabled,
    ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
  }
}

function GatewayEditor({
  draft, error, saving, onChange, onSubmit, onClose,
}: {
  draft: Draft
  error: string | null
  saving: boolean
  onChange: (draft: Draft) => void
  onSubmit: () => void
  onClose: () => void
}) {
  const toggleProtocol = (protocol: AiGatewayProtocol, on: boolean) => {
    const protocols = on ? [...draft.protocols, protocol] : draft.protocols.filter((item) => item !== protocol)
    const authProtocols = { ...draft.authProtocols }
    if (on) authProtocols[protocol] ??= 'bearer'
    else delete authProtocols[protocol]
    onChange({ ...draft, protocols, authProtocols })
  }
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{draft.id ? `Edit ${draft.name || 'gateway'}` : 'Add an AI gateway'}</DialogTitle>
        <DialogDescription>The key is stored in the secret vault. A blank replacement leaves the current key in place.</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => { event.preventDefault(); onSubmit() }}
      >
        <Label htmlFor="ai-gateway-name">Name</Label>
        <Input id="ai-gateway-name" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        <Label htmlFor="ai-gateway-url">API base URL</Label>
        <Input id="ai-gateway-url" value={draft.baseUrl} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} placeholder="https://gateway.example/v1" />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">API formats</legend>
          {AI_GATEWAY_PROTOCOLS.map((protocol) => (
            <label key={protocol} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={draft.protocols.includes(protocol)}
                onChange={(event) => toggleProtocol(protocol, event.target.checked)}
              />
              {PROTOCOL_LABELS[protocol]}
            </label>
          ))}
        </fieldset>
        {draft.protocols.map((protocol) => (
          <label key={protocol} className="flex flex-col gap-1 text-[13px]">
            {PROTOCOL_LABELS[protocol]} auth
            <select
              className={selectStyle}
              aria-label={`${PROTOCOL_LABELS[protocol]} auth`}
              value={draft.authProtocols[protocol] ?? 'bearer'}
              onChange={(event) => onChange({ ...draft, authProtocols: { ...draft.authProtocols, [protocol]: event.target.value as AiGatewayAuthMode } })}
            >
              {AI_GATEWAY_AUTH_MODES.map((mode) => <option key={mode} value={mode}>{AUTH_LABELS[mode]}</option>)}
            </select>
          </label>
        ))}
        <label className="flex flex-col gap-1 text-[13px]">
          Catalog auth
          <select className={selectStyle} aria-label="Catalog auth" value={draft.catalog} onChange={(event) => onChange({ ...draft, catalog: event.target.value as AiGatewayAuthMode })}>
            {AI_GATEWAY_AUTH_MODES.map((mode) => <option key={mode} value={mode}>{AUTH_LABELS[mode]}</option>)}
          </select>
        </label>
        <Label htmlFor="ai-gateway-key">{draft.hasApiKey ? 'Replacement API key' : 'API key'}</Label>
        <Input
          id="ai-gateway-key"
          type="password"
          autoComplete="off"
          value={draft.apiKey}
          placeholder={draft.hasApiKey ? 'API key saved' : ''}
          onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
        />
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={draft.enabled} aria-label="Gateway enabled" onCheckedChange={(enabled) => onChange({ ...draft, enabled })} />
          On
        </label>
        {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>Save gateway</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

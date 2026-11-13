import { ExternalLinkIcon } from 'lucide-react'
import * as React from 'react'

import { useModelGateway, useRemoveModelGateway, useSaveModelGateway } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ModelGatewayInput, ModelGatewayPreset, ModelGatewayState } from '@open-mercato/cezar-api-client'

/**
 * One API key for a service that sells many models, on which OpenCode runs (spec
 * 2026-11-10-model-gateway). The key is checked with the gateway, stored sealed, and only ever
 * given to OpenCode; this form never sees it again.
 */
export function ModelGatewayPanel({ onSaved }: { onSaved?: (state: ModelGatewayState) => void }) {
  const query = useModelGateway()
  const [editing, setEditing] = React.useState(false)
  if (query.isPending) return null
  if (query.isError) {
    return (
      <p role="alert" className="text-ui text-danger">
        {query.error.message}
      </p>
    )
  }
  const state = query.data
  if (state.gateway && !editing) return <GatewaySummary state={state} onReplace={() => setEditing(true)} />
  return (
    <GatewayForm
      state={state}
      onCancel={state.gateway ? () => setEditing(false) : undefined}
      onSaved={(next) => {
        setEditing(false)
        onSaved?.(next)
      }}
    />
  )
}

function GatewaySummary({ state, onReplace }: { state: ModelGatewayState; onReplace: () => void }) {
  const remove = useRemoveModelGateway()
  const gateway = state.gateway!
  const models = gateway.preset === 'openrouter' ? 'Every OpenRouter model' : `${gateway.models.length} model${gateway.models.length === 1 ? '' : 's'}`
  return (
    <div data-slot="model-gateway" data-state="saved" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-ui font-semibold text-foreground">{gateway.name}</div>
        <div className="truncate text-xs text-muted-foreground" title={gateway.baseUrl}>
          {hostOf(gateway.baseUrl)} · {models} · runs on OpenCode
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="font-normal" onClick={onReplace}>
          Replace key
        </Button>
        <Button size="sm" variant="outline" className="font-normal" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Remove
        </Button>
      </div>
      {remove.isError ? (
        <p role="alert" className="w-full text-ui text-danger">
          {remove.error.message}
        </p>
      ) : null}
    </div>
  )
}

function GatewayForm({ state, onCancel, onSaved }: { state: ModelGatewayState; onCancel?: () => void; onSaved: (state: ModelGatewayState) => void }) {
  const save = useSaveModelGateway()
  const [preset, setPreset] = React.useState<ModelGatewayPreset>(state.gateway?.preset ?? state.presets[0]?.id ?? 'custom')
  const [name, setName] = React.useState(state.gateway?.preset === 'custom' ? state.gateway.name : '')
  const [baseUrl, setBaseUrl] = React.useState(state.gateway?.preset === 'custom' ? state.gateway.baseUrl : '')
  const [models, setModels] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const chosen = state.presets.find((candidate) => candidate.id === preset)
  const custom = preset === 'custom'
  const ids = models.split(/[\s,]+/).filter(Boolean)
  const ready = apiKey.trim().length > 0 && (!custom || (name.trim() && baseUrl.trim()))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready || save.isPending) return
    const input: ModelGatewayInput = custom
      ? { preset: 'custom', name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), ...(ids.length ? { models: ids } : {}) }
      : { preset: 'openrouter', apiKey: apiKey.trim() }
    save.mutate(input, {
      onSuccess: (next) => {
        setApiKey('')
        onSaved(next)
      },
    })
  }

  return (
    <form data-slot="model-gateway" data-state="form" onSubmit={submit} className="flex flex-col gap-3 rounded-md border border-border bg-card px-3.5 py-3 text-left">
      {state.error ? (
        <p role="alert" className="text-ui text-danger">
          {state.error}
        </p>
      ) : null}
      <div role="radiogroup" aria-label="Gateway" className="flex flex-wrap gap-2">
        {state.presets.map((candidate) => (
          <Button
            key={candidate.id}
            type="button"
            size="sm"
            role="radio"
            aria-checked={candidate.id === preset}
            variant={candidate.id === preset ? 'primary' : 'outline'}
            className="font-normal"
            onClick={() => setPreset(candidate.id)}
          >
            {candidate.name}
          </Button>
        ))}
      </div>
      {custom ? (
        <>
          <Field id="gateway-name" label="Name">
            <Input id="gateway-name" value={name} maxLength={60} placeholder="Acme AI" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field id="gateway-url" label="Base URL" hint="An OpenAI-compatible endpoint, e.g. https://api.example.com/v1">
            <Input id="gateway-url" type="url" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setBaseUrl(event.target.value)} />
          </Field>
        </>
      ) : null}
      <Field id="gateway-key" label="API key">
        <Input id="gateway-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
      </Field>
      {custom ? (
        <Field id="gateway-models" label="Models (optional)" hint={`Leave empty to read them from ${baseUrl.trim() ? `${baseUrl.trim().replace(/\/+$/, '')}/models` : 'the endpoint’s /models'}.`}>
          <Input id="gateway-models" value={models} placeholder="model-a, model-b" onChange={(event) => setModels(event.target.value)} />
        </Field>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-ui text-danger">
          {save.error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {chosen?.keyUrl ? (
          <a href={chosen.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui text-muted-foreground underline-offset-2 hover:underline">
            Create a key on {chosen.name}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        ) : (
          <span className="text-xs text-soft-foreground">Stored encrypted; only OpenCode receives it.</span>
        )}
        <div className="flex gap-2">
          {onCancel ? (
            <Button type="button" size="sm" variant="outline" className="font-normal" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" className="font-normal" disabled={!ready || save.isPending}>
            {save.isPending ? 'Checking the key…' : 'Save key'}
          </Button>
        </div>
      </div>
    </form>
  )
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-ui">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-soft-foreground">{hint}</p> : null}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

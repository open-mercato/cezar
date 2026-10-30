import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  addLlmProvider,
  deleteLlmProvider,
  llmProvidersKey,
  useLlmProviders,
  type CreateLlmProvider,
} from '@/api/llm-providers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function LlmProviderSettings() {
  const query = useLlmProviders()
  const client = useQueryClient()
  const [kind, setKind] = useState<'openrouter' | 'custom'>('openrouter')
  const [name, setName] = useState('OpenRouter')
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1')
  const [protocol, setProtocol] =
    useState<CreateLlmProvider['protocol']>('openai-completions')
  const [apiKey, setApiKey] = useState('')
  const save = useMutation({
    mutationFn: addLlmProvider,
    onSuccess: async () => {
      setApiKey('')
      await client.invalidateQueries({ queryKey: llmProvidersKey })
    },
  })
  const remove = useMutation({
    mutationFn: deleteLlmProvider,
    onSuccess: () => client.invalidateQueries({ queryKey: llmProvidersKey }),
  })
  return (
    <section className="mt-6 space-y-3" aria-labelledby="llm-provider-heading">
      <h3 id="llm-provider-heading" className="text-sm font-semibold">
        LLM providers
      </h3>
      <p className="text-sm text-muted-foreground">
        Use your agent’s existing setup, or add an API provider to choose for
        individual tasks. Connections are shared across projects. Adding one
        keeps your current setup unchanged.
      </p>
      {query.isError ? (
        <p role="alert">
          Could not load LLM providers.{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </p>
      ) : null}
      {query.data?.providers.map((provider) => (
        <div
          key={provider.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
        >
          <div>
            <p className="text-sm font-medium">{provider.name}</p>
            <p className="text-xs text-muted-foreground">
              {provider.baseUrl} · {provider.protocol} ·{' '}
              {provider.hasApiKey ? 'API key stored' : 'API key missing'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(provider.id)}
          >
            Remove {provider.name}
          </Button>
        </div>
      ))}
      <form
        className="grid gap-3 rounded-md border p-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ kind, name, baseUrl, protocol, apiKey })
        }}
      >
        <Label htmlFor="llm-kind">Provider type</Label>
        <Select
          value={kind}
          onValueChange={(value) => {
            const next = value as typeof kind
            setKind(next)
            setName(next === 'openrouter' ? 'OpenRouter' : '')
            setBaseUrl(
              next === 'openrouter' ? 'https://openrouter.ai/api/v1' : '',
            )
            setProtocol('openai-completions')
          }}
        >
          <SelectTrigger id="llm-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openrouter">OpenRouter</SelectItem>
            <SelectItem value="custom">Custom API / AI gateway</SelectItem>
          </SelectContent>
        </Select>
        <Label htmlFor="llm-name">Connection name</Label>
        <Input
          id="llm-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
        />
        {kind === 'custom' ? (
          <>
            <Label htmlFor="llm-url">API base URL</Label>
            <Input
              id="llm-url"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://gateway.example/v1"
              required
            />
            <Label htmlFor="llm-protocol">API format</Label>
            <Select
              value={protocol}
              onValueChange={(value) => setProtocol(value as typeof protocol)}
            >
              <SelectTrigger id="llm-protocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-completions">
                  OpenAI Chat Completions
                </SelectItem>
                <SelectItem value="openai-responses">
                  OpenAI Responses (Codex)
                </SelectItem>
                <SelectItem value="anthropic-messages">
                  Anthropic Messages (Claude Code)
                </SelectItem>
              </SelectContent>
            </Select>
          </>
        ) : null}
        <Label htmlFor="llm-key">API key</Label>
        <Input
          id="llm-key"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          Models are read from this provider's /models endpoint. Keys are
          write-only and stored encrypted.{' '}
          {query.data?.keyBackend === 'file'
            ? 'This machine uses a local 0600 key file; protection is equivalent to private local files.'
            : 'The encryption key is held in the OS keychain when available.'}
        </p>
        <Button
          type="submit"
          disabled={
            save.isPending || !apiKey.trim() || !name.trim() || !baseUrl.trim()
          }
        >
          {save.isPending ? 'Saving…' : 'Add LLM provider'}
        </Button>
      </form>
      {save.isError || remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error?.message ?? remove.error?.message}
        </p>
      ) : null}
    </section>
  )
}

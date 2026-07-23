import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useState } from 'react'

import { ApiError, connectProvider } from '@/api/client'
import {
  useProviderStatus,
  useRefreshProviderStatus,
  workspaceQueryKeys,
} from '@/api/queries'
import type { ProviderId } from '@/api/types'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', login: 'claude auth login' },
  { id: 'codex', label: 'Codex', login: 'codex login' },
  { id: 'opencode', label: 'OpenCode', login: 'opencode auth login' },
] as const

const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: StatusDotTone }>

interface ManualCommand {
  provider: ProviderId
  label: string
  message: string
  command: string
}

export function ProviderSettings() {
  const status = useProviderStatus()
  const refresh = useRefreshProviderStatus()
  const queryClient = useQueryClient()
  const [manual, setManual] = useState<ManualCommand | null>(null)

  useEffect(() => {
    if (manual && providerStatusFor(status.data, manual.provider)?.status === 'connected') {
      setManual(null)
    }
  }, [manual, status.data])

  const connect = useMutation({
    mutationFn: connectProvider,
    onSuccess: async (result) => {
      setManual(null)
      toast(
        result.opened
          ? 'Finish signing in in the terminal, then check again.'
          : 'Provider is already connected.',
      )
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
    },
    onError: (error: Error, provider) => {
      if (error instanceof ApiError && error.command) {
        const label = PROVIDERS.find((item) => item.id === provider)?.label ?? provider
        setManual({ provider, label, message: error.message, command: error.command })
        return
      }
      toast(error.message, { tone: 'danger' })
    },
  })

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      toast('Command copied')
    } catch {
      toast('Could not copy the command', { tone: 'danger' })
    }
  }

  return (
    <section id="providers" data-slot="provider-settings" className="scroll-mt-20">
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-foreground">Providers</h2>
        <p className="text-[13px] text-muted-foreground">
          Connect the coding agents available on this computer.
        </p>
      </div>

      {status.isError ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5"
        >
          <div>
            <p className="text-[13px] font-medium text-foreground">
              Provider status could not be loaded
            </p>
            <p className="text-xs text-muted-foreground">{status.error.message}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {PROVIDERS.map((provider) => {
          const current = providerStatusFor(status.data, provider.id)
          const state = current?.status
          const presentation = state
            ? STATUS_PRESENTATION[state]
            : status.isPending
              ? { label: 'Checking…', tone: 'neutral' as const }
              : STATUS_PRESENTATION.unknown
          const isConnecting = connect.isPending && connect.variables === provider.id
          const canRefresh = state === 'disconnected' || state === 'unknown'

          return (
            <Fragment key={provider.id}>
              <div
                data-slot="provider-card"
                data-provider={provider.id}
                className="rounded-md border border-border bg-card px-3.5 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[13px] font-semibold text-foreground">{provider.label}</h3>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <StatusDot tone={presentation.tone} pulse={status.isPending} />
                      <span>{presentation.label}</span>
                    </div>
                    {state === 'not-installed' ? (
                      <p className="mt-1.5 text-xs text-soft-foreground">
                        Install {provider.label}, then run <code>{provider.login}</code>.
                      </p>
                    ) : state === 'unknown' || (status.isError && !state) ? (
                      <p className="mt-1.5 text-xs text-soft-foreground">
                        Verification failed. Check again when the provider is available.
                      </p>
                    ) : current?.hint ? (
                      <p className="mt-1.5 text-xs text-soft-foreground">{current.hint}</p>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    {canRefresh ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={refresh.isPending}
                        onClick={() => refresh.mutate()}
                      >
                        Check again
                      </Button>
                    ) : null}
                    {state === 'disconnected' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={connect.isPending}
                        onClick={() => connect.mutate(provider.id)}
                      >
                        {isConnecting ? 'Opening…' : 'Connect'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {manual?.provider === provider.id && state !== 'connected' ? (
                <div
                  role="region"
                  aria-label={`${manual.label} manual sign-in`}
                  className="rounded-md border border-pending/40 bg-pending/5 px-3.5 py-3"
                >
                  <p className="text-[13px] text-foreground">{manual.message}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded-sm bg-muted px-2 py-1.5 text-xs">
                      {manual.command}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copyCommand(manual.command)}
                    >
                      Copy command
                    </Button>
                  </div>
                </div>
              ) : null}
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}

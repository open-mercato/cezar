import { XIcon } from 'lucide-react'

import type { ProviderStatusResponse } from '@open-mercato/cezar-api-client'
import { Link } from '@/lib/project-router'
import {
  type ProviderAuthDismissals,
  type ProviderAuthIncident,
  visibleProviderAuthIncidents,
} from '@/lib/provider-auth-alert'
import { parseProviderStatusResponse } from '@/lib/provider-status'

import { ReconnectButton, ReconnectProgress } from './reconnect/reconnect-row'
import { StatusDot } from './status-dot'

interface ProviderBannerProps {
  status: ProviderStatusResponse | undefined
  pending: boolean
  error: boolean
  dismissals: ProviderAuthDismissals
  onDismissAuthFailures: (incidents: readonly ProviderAuthIncident[]) => void
}

export function ProviderBanner({
  status,
  pending,
  error,
  dismissals,
  onDismissAuthFailures,
}: ProviderBannerProps) {
  if (pending || !status) return null
  let normalized: ProviderStatusResponse
  try {
    normalized = parseProviderStatusResponse(status)
  } catch {
    return null
  }

  const incidents = visibleProviderAuthIncidents(normalized, dismissals)
  if (incidents.length > 0) {
    return (
      <div data-slot="provider-banner-wrap" className="border-b border-border">
        <div
          data-slot="provider-banner"
          role="alert"
          className="flex min-h-9 flex-wrap items-center gap-2 bg-destructive/10 px-4 py-1 text-sm text-foreground"
        >
          <StatusDot tone="danger" />
          <span>
            Provider authentication failed during a task:{' '}
            {incidents.map(({ label }) => label).join(', ')}.
          </span>
          {/* Inline reconnect (spec 2026-11-18-inline-account-reconnect): the incident is the
              discovered login's, so the account is `default`. */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {incidents.map(({ provider, label }) => (
              <ReconnectButton
                key={provider}
                provider={provider}
                profileId="default"
                label={incidents.length > 1 ? `Reconnect ${label}` : 'Reconnect'}
              />
            ))}
          </span>
          <Link
            to="/settings/agents#providers"
            className="shrink-0 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open agent settings
          </Link>
          <button
            type="button"
            aria-label="Dismiss provider authentication alert"
            onClick={() => onDismissAuthFailures(incidents)}
            className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
        {incidents.map(({ provider }) => (
          <ReconnectProgress key={provider} provider={provider} profileId="default" className="mx-4 mb-2" />
        ))}
      </div>
    )
  }

  if (error) return null
  const usable = normalized.providers.some(
    (row) => row.enabled && row.status === 'connected',
  )
  if (usable) return null
  const credentialsExist = normalized.providers.some(
    (row) => row.status === 'connected',
  )
  const uncertain = normalized.providers.some((row) => row.status === 'unknown')
  const message = credentialsExist
    ? 'No agent provider is enabled.'
    : uncertain
      ? 'No connected provider could be verified.'
      : 'No agent provider credentials were found.'

  return (
    <div
      data-slot="provider-banner"
      role="status"
      className="flex min-h-9 items-center gap-2 border-b border-border bg-muted/50 px-4 text-sm text-muted-foreground"
    >
      <StatusDot tone={uncertain ? 'danger' : 'pending'} />
      <span>{message}</span>
      <Link
        to="/settings/agents#providers"
        className="ml-auto shrink-0 font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Configure providers
      </Link>
    </div>
  )
}

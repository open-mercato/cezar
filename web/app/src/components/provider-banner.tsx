import type { ProviderStatusResponse } from '@/api/types'
import { Link } from '@/lib/project-router'
import { parseProviderStatusResponse } from '@/lib/provider-status'

import { StatusDot } from './status-dot'

interface ProviderBannerProps {
  status: ProviderStatusResponse | undefined
  pending: boolean
  error: boolean
}

export function ProviderBanner({ status, pending, error }: ProviderBannerProps) {
  if (pending || error || !status) return null
  let normalized: ProviderStatusResponse
  try {
    normalized = parseProviderStatusResponse(status)
  } catch {
    return null
  }
  if (normalized.providers.some((row) => row.status === 'connected')) return null

  const uncertain = normalized.providers.some((row) => row.status === 'unknown')
  const message = uncertain
    ? 'No connected provider could be verified.'
    : 'No agent provider is connected.'

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

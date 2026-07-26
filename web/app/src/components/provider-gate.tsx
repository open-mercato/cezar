import { Link } from '@/lib/project-router'

export function providerDisabledReason({
  pending,
  error,
}: {
  pending: boolean
  error: boolean
}): string {
  if (pending) return 'Checking agent providers…'
  if (error) return 'Provider authentication could not be verified.'
  return 'Connect an agent provider before starting a task.'
}

export function ProviderGate({ pending, error }: { pending: boolean; error: boolean }) {
  if (pending) return null
  return (
    <span
      data-slot="provider-gate"
      className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      {providerDisabledReason({ pending, error })}
      <Link
        to="/settings/agents#providers"
        className="font-medium text-foreground underline underline-offset-4"
      >
        Configure providers
      </Link>
    </span>
  )
}

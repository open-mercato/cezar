import { useProviderStatus } from '@/api/queries'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'
import { usableRunners } from '@/lib/provider-status'
import { resolveRunner } from '@/routes/new-task-form'

/**
 * One provider decision for every UI path that reopens an existing agent session (#719).
 *
 * Loading posture, shared with the live-run gate (`useActiveProviderAvailability`): optimistic
 * while provider status is pending — the server's `/continue` gate is the boundary — and
 * blocked once it has answered with an error or no usable provider. While pending no runner
 * override is sent, so the run keeps its recorded backend rather than a guessed fallback.
 */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null) {
  const providers = useProviderStatus()
  const runners = usableRunners(providers.data)
  const currentRunner = (run.runner ?? 'claude') as Runner
  const runner = resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const canContinue = providers.isPending || (providers.isSuccess && runners.length > 0)
  const reason = providers.isError
    ? 'Provider authentication could not be verified.'
    : canContinue
      ? undefined
      : 'Connect an agent provider to continue.'

  return {
    runners,
    currentRunner,
    runner,
    currentRunnerConnected,
    canContinue,
    providerPending: providers.isPending,
    providerError: providers.isError,
    reason,
    runnerOverride:
      !providers.isPending && (pickedRunner !== null || !currentRunnerConnected)
        ? runner
        : undefined,
  }
}

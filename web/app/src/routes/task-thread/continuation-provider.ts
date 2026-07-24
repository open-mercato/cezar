import { useProviderStatus } from '@/api/queries'
import type { ApiRun, Runner } from '@/api/types'
import { usableRunners } from '@/lib/provider-status'
import { resolveRunner } from '@/routes/new-task-form'

/** One provider decision for every UI path that reopens an existing agent session. */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null) {
  const providers = useProviderStatus()
  const runners = usableRunners(providers.data)
  const currentRunner = (run.runner ?? 'claude') as Runner
  const runner = resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const canContinue = providers.isSuccess && runners.length > 0
  const reason = providers.isPending
    ? 'Checking agent providers…'
    : providers.isError
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
      pickedRunner !== null || !currentRunnerConnected
        ? runner
        : undefined,
  }
}

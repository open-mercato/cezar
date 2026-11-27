import { providerForExistingRun, useRunProviderStatus } from './active-provider'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'
import { resolveRunner } from '@/routes/new-task-form'

/**
 * One provider decision for every UI path that reopens an existing agent session (#719).
 *
 * Loading posture, shared with the live-run gate (`useActiveProviderAvailability`): optimistic
 * while provider status is pending — the server's `/continue` gate is the boundary — and
 * blocked once it has answered with an error or no usable provider. While pending no runner
 * override is sent, so the run keeps its recorded backend rather than a guessed fallback.
 */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null, pickedAccount: string | null = null) {
  const currentRunner = providerForExistingRun(run)
  const selectedRunner = pickedRunner ?? currentRunner
  const providers = useRunProviderStatus(run, selectedRunner, { account: pickedAccount, replay: selectedRunner === currentRunner })
  const usable = providers.runners
  const runner = providers.isPending || providers.bound ? selectedRunner : pickedRunner ?? resolveRunner(null, usable, currentRunner)
  const canContinue = !providers.isError && (providers.isPending || usable.includes(runner))
  // A blocked login can still be changed in the picker. A run bound to that account must
  // never start on some other agent just because it is first in the list.
  const runners = providers.bound && !usable.includes(selectedRunner) ? [selectedRunner, ...usable] : usable
  const reason = providers.isError
    ? 'Provider authentication could not be verified.'
    : canContinue
      ? undefined
      : providers.accountReason ?? 'Connect an agent provider to continue.'

  return {
    accounts: providers.accounts,
    repoAccount: providers.repoAccount,
    accountId: runner === selectedRunner ? providers.accountId : providers.repoAccount?.[runner],
    runners,
    currentRunner,
    runner,
    canContinue,
    providerPending: providers.isPending,
    reason,
    runnerOverride: runner !== currentRunner ? runner : undefined,
  }
}

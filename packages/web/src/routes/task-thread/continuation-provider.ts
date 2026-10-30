import { supportsLlmProvider } from '@open-mercato/cezar-api-client'
import { useLlmProviders } from '@/api/llm-providers'
import { useProviderStatus } from '@/api/queries'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'
import { usableRunners } from '@/lib/provider-status'
import { resolveRunner } from '@/routes/new-task-form'

/** One provider decision for every UI path that reopens an existing agent session. */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null, selectedConnection: string | null = run.llmProviderId ?? null) {
  const providers = useProviderStatus()
  const connections = useLlmProviders()
  const nativeRunners = usableRunners(providers.data)
  const external = connections.data?.providers.find(provider => provider.id === selectedConnection)
  const runners = selectedConnection ? (providers.data?.providers ?? []).filter(row => row.enabled !== false && row.status !== 'not-installed' && external && external.hasApiKey && supportsLlmProvider(row.provider, external)).map(row => row.provider) : nativeRunners
  const currentRunner = (run.runner ?? 'claude') as Runner
  const runner = selectedConnection ? pickedRunner ?? currentRunner : resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const canContinue = providers.isSuccess && runners.includes(runner)
  const reason = providers.isPending
    ? 'Checking agent providers…'
    : providers.isError
      ? 'Provider authentication could not be verified.'
      : canContinue
        ? undefined
        : selectedConnection ? 'Selected LLM provider is unavailable. Choose a connection explicitly.' : 'Connect an agent provider to continue.'

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

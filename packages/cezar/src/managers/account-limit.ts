/** An agent account's usage-limit state for a manager, keyed exactly as the queue keys holds. */
import { providerQuotaKey } from '../core/agent-provider-env.ts';
import { readAgentProviders } from '../workspace/agent-providers.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts } from '../workspace/agent-accounts.ts';
import type { AccountHolds } from '../workspace/semaphore.ts';
import { runAccountKey } from '../workflows/run.ts';

export async function managerAccountLimit(
  holds: () => AccountHolds | undefined,
  runner: RunnerId,
  agentProfile: string | undefined,
  repoRoot?: string,
  model?: string,
): Promise<{ account: string; label: string; quotaKey?: string; until?: number }> {
  const store = await loadAgentAccounts().catch(() => undefined);
  // `runAccountKey` is the queue's own key, so a hold the pump honors is the hold reported here.
  const key = runAccountKey({ runner, agentProfile }, runner, store && repoRoot ? { store, repoRoot } : undefined);
  const account = key.slice(runner.length + 1);
  const named = store?.accounts.find((entry) => entry.id === account && entry.provider === runner);
  const quotaKey = providerQuotaKey(runner, key, undefined, await readAgentProviders(), model);
  const until = holds()?.deadlines?.get(quotaKey);
  return {
    account,
    ...(quotaKey === key ? {} : { quotaKey }),
    label: named?.label || (account === DEFAULT_AGENT_ACCOUNT_ID ? 'default account' : account),
    ...(until !== undefined && until > Date.now() ? { until } : {}),
  };
}

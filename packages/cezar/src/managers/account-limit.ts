/** An agent account's usage-limit state for a manager, keyed exactly as the queue keys holds. */
import { isRunnerId, type RunnerId } from '../core/agent-runner.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts } from '../workspace/agent-accounts.ts';
import type { AccountHolds } from '../workspace/semaphore.ts';
import { runAccountKey } from '../workflows/run.ts';

export async function managerAccountLimit(
  holds: () => AccountHolds | undefined,
  runner: RunnerId,
  agentProfile: string | undefined,
  repoRoot?: string,
): Promise<{ account: string; label: string; until?: number }> {
  const store = await loadAgentAccounts().catch(() => undefined);
  // `runAccountKey` is the queue's own key, so a hold the pump honors is the hold reported here.
  const key = runAccountKey({ runner, agentProfile }, runner, store && repoRoot ? { store, repoRoot } : undefined);
  const account = key.slice(runner.length + 1);
  const named = store?.accounts.find((entry) => entry.id === account && entry.provider === runner);
  const until = holds()?.deadlines?.get(key);
  return {
    account,
    label: named?.label || (account === DEFAULT_AGENT_ACCOUNT_ID ? 'default account' : account),
    ...(until !== undefined && until > Date.now() ? { until } : {}),
  };
}

/**
 * The part of a `POST /runs` fallback list the named manager allows: a caller's `startedByManager`
 * is provenance, never consent, so only the manager's own task accounts may fall back (#2463).
 */
export async function managerFallbackWithin(
  taskAgents: readonly { runner: string; agentProfile?: string }[] | undefined,
  fallback: readonly { provider: RunnerId; profileId: string }[],
  repoRoot: string,
): Promise<Array<{ provider: RunnerId; profileId: string }>> {
  if (!taskAgents?.length) return [];
  const store = await loadAgentAccounts().catch(() => undefined);
  const allowed = new Set(taskAgents.filter((agent): agent is { runner: RunnerId; agentProfile?: string } => isRunnerId(agent.runner))
    .map((agent) => runAccountKey({ runner: agent.runner, agentProfile: agent.agentProfile }, agent.runner, store ? { store, repoRoot } : undefined)));
  return fallback.filter((candidate) => allowed.has(`${candidate.provider}:${candidate.profileId}`));
}

import type {
  ProviderAuthService,
  ProviderId,
  ProviderStatus,
  ProviderStatusResponse,
} from '../core/provider-auth.ts';
import { PROVIDER_IDS } from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
import { loadAgentAccounts, type AgentAccountStore } from '../workspace/agent-accounts.ts';
import { selectProfile } from '../workspace/agent-profiles.ts';
import { stepKind, type WorkflowDef } from '../workflows/types.ts';

const ORDER: readonly ProviderId[] = PROVIDER_IDS;
const LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'pi',
  junie: 'Junie',
  copilot: 'GitHub Copilot CLI',
};

export function providersRequiredByWorkflow(
  workflow: WorkflowDef,
  fallback: ProviderId,
): ProviderId[] {
  const required = new Set<ProviderId>();
  for (const step of workflow.steps) {
    if (stepKind(step) === 'agent') required.add(step.runner ?? fallback);
  }
  return ORDER.filter((provider) => required.has(provider));
}

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  return run.runner ?? 'claude';
}

/** The provider that owns a currently live session, when the record is attributed. */
export function providerForActiveRun(run: RunRecord): ProviderId {
  const current = run.currentStepId
    ? run.steps.find((step) => step.id === run.currentStepId)
    : undefined;
  if (current?.backend) return current.backend;

  // `execute()` persists the task backend before it starts a step. This is the
  // conservative fallback for older records whose current step lacks affinity.
  if (run.runner) return run.runner;

  // Pre-affinity records can still carry a prior attributed session. It is a
  // better fallback than guessing Claude, but never outranks the live step or
  // the run's current runner.
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const backend = run.steps[index]?.backend;
    if (backend) return backend;
  }
  return 'claude';
}

/** Which account a gated action runs on, per provider: an explicit id (a run's recorded or composer
 *  account), else the project's selection, else the discovered default — `selectProfile`'s order. */
export interface ProviderAccountScope {
  repoRoot?: string;
  profileFor?: (provider: ProviderId) => string | undefined;
}

/**
 * Re-answer each required provider's row for the account the action will actually use.
 *
 * `status()` describes the DEFAULT login only, so a project running on a named Claude account was
 * refused whenever `~/.claude` itself was logged out (telemetry ac53a6ef). A disabled row and a
 * latched runtime failure are provider-wide facts and are kept as they are.
 */
export async function withSelectedAccounts(
  response: ProviderStatusResponse,
  required: readonly ProviderId[],
  scope: ProviderAccountScope,
  auth: Pick<ProviderAuthService, 'profileStatus' | 'forgetProfileStatus'>,
  options: { refresh?: boolean; loadStore?: () => Promise<AgentAccountStore> } = {},
): Promise<ProviderStatusResponse> {
  let store: AgentAccountStore;
  try {
    store = await (options.loadStore ?? loadAgentAccounts)();
  } catch {
    return response;
  }
  const providers = await Promise.all(response.providers.map(async (row) => {
    if (!required.includes(row.provider) || row.enabled === false || row.authFailureId) return row;
    const profile = selectProfile(store, {
      provider: row.provider,
      repoRoot: scope.repoRoot,
      profileId: scope.profileFor?.(row.provider),
    });
    if (profile.isDefault) return row;
    if (options.refresh) auth.forgetProfileStatus(row.provider, profile.id);
    const account = await auth.profileStatus(row.provider, { id: profile.id, configDir: profile.path });
    const answered: ProviderStatus = { ...row, status: account.status };
    if (account.hint !== undefined) answered.hint = account.hint;
    else delete answered.hint;
    return answered;
  }));
  return { providers };
}

/** The account a step of an existing run is bound to: its recorded one, else the run's override. */
export function recordedProfileFor(run: RunRecord, provider: ProviderId): string | undefined {
  const runner = run.runner ?? 'claude';
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step?.profileId && (step.backend ?? runner) === provider) return step.profileId;
  }
  return provider === runner ? run.agentProfile : undefined;
}

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    if (row?.enabled === false) {
      return `${LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`;
    }
    // Junie has no read-only auth-status command: its probe deliberately reports unknown.
    // Let ACP authenticate at run startup; a real runtime rejection is still latched as disconnected.
    if (row?.status !== 'connected' && !(provider === 'junie' && row?.status === 'unknown')) {
      return `${LABEL[provider]} credentials are unavailable. Authorize it in Settings → Agents → Providers.`;
    }
  }
  return null;
}

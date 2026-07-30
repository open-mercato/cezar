import type {
  ProviderId,
  ProviderStatusResponse,
} from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
import { stepKind, type WorkflowDef } from '../workflows/types.ts';

const ORDER: readonly ProviderId[] = ['claude', 'codex', 'opencode'];
const LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
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

interface HarnessProviderInput {
  profile?: string;
  roles?: {
    orchestrator?: { runner?: string };
    implementer?: { runner?: string };
    reviewers?: Array<{ runner?: string }>;
  };
}

/**
 * Dynamic harness phases do not appear in workflow YAML, so the ordinary
 * provider gate cannot see them. Collect runner-backed roles and configured
 * command adapters before a run/worktree exists; HTTP advisors remain covered
 * by the harness readiness probe because they are not cezar providers.
 */
export function providersRequiredByHarness(
  harness: HarnessProviderInput | undefined,
  agentHarness: Record<string, unknown> | undefined,
): ProviderId[] {
  const required = new Set<ProviderId>();
  const add = (candidate: unknown) => {
    if (candidate === 'claude' || candidate === 'codex' || candidate === 'opencode') {
      required.add(candidate);
    }
  };

  if (harness?.roles) {
    add(harness.roles.orchestrator?.runner);
    add(harness.roles.implementer?.runner);
    for (const reviewer of harness.roles.reviewers ?? []) add(reviewer.runner);
  } else {
    add('claude');
  }
  if (!harness?.roles && harness?.profile && agentHarness) {
    const profiles = agentHarness.profiles as Record<string, unknown> | undefined;
    const profile = profiles?.[harness.profile] as
      | { workers?: unknown; reviewers?: unknown }
      | undefined;
    const models = (agentHarness.models as Record<string, unknown> | undefined) ?? {};
    const ids = [
      ...(Array.isArray(profile?.workers) ? profile.workers : []),
      ...(Array.isArray(profile?.reviewers) ? profile.reviewers : []),
    ];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const model = models[id] as
        | { adapter?: unknown; commands?: { worker?: unknown; review?: unknown } }
        | undefined;
      const command =
        (Array.isArray(model?.commands?.worker) ? model?.commands?.worker : undefined) ??
        (Array.isArray(model?.commands?.review) ? model?.commands?.review : undefined);
      add(command?.[0]);
    }
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

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    if (row?.enabled === false) {
      return `${LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`;
    }
    if (row?.status !== 'connected') {
      return `${LABEL[provider]} credentials are unavailable. Authorize it in Settings → Agents → Providers.`;
    }
  }
  return null;
}

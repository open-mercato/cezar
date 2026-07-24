import type {
  ProviderId,
  ProviderStatusResponse,
} from '../core/provider-auth.js';
import type { RunRecord } from '../runs/store.js';
import { stepKind, type WorkflowDef } from '../workflows/types.js';

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

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const backend = run.steps[index]?.backend;
    if (backend) return backend;
  }
  return run.runner ?? 'claude';
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

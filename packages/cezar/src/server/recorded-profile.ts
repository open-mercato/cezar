import type { ProviderId } from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';

// Type-only imports: the runtime-auth watcher needs this without the action gate's workflow graph.
/** The account a step of an existing run is bound to: its recorded one, else the run's override. */
export function recordedProfileFor(run: RunRecord, provider: ProviderId): string | undefined {
  const runner = run.runner ?? 'claude';
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step?.profileId && (step.backend ?? runner) === provider) return step.profileId;
  }
  return provider === runner ? run.agentProfile : undefined;
}

import {
  isRuntimeProviderAuthFailure,
  type ProviderAuthService,
  type ProviderId,
  type ProviderStatus,
} from '../core/provider-auth.js';
import type { RunEvent, RunStore } from '../runs/store.js';

const AUTH_ERROR_EVENT_TYPES = new Set(['error', 'session.error', 'note']);

export function watchProviderRuntimeAuthFailures(
  store: RunStore,
  providerAuth: ProviderAuthService,
  onInvalidated: (status: ProviderStatus) => void,
): () => void {
  const onEvent = ({ runId, event }: { runId: string; event: RunEvent }): void => {
    if (!AUTH_ERROR_EVENT_TYPES.has(event.type)) return;
    const message = event.message;
    if (typeof message !== 'string' || !isRuntimeProviderAuthFailure(message)) return;

    const run = store.getRun(runId);
    if (!run) return;
    const step = typeof event.stepId === 'string'
      ? run.steps.find(({ id }) => id === event.stepId)
      : undefined;
    const provider: ProviderId = step?.backend ?? run.runner ?? 'claude';
    const status = providerAuth.reportRuntimeAuthFailure(provider);
    if (status) onInvalidated(status);
  };

  store.on('event', onEvent);
  return () => store.off('event', onEvent);
}

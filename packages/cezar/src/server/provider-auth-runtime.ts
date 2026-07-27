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
    const report = providerAuth.reportRuntimeAuthFailure(provider);
    if (!report) return;
    if (report.transitioned) onInvalidated(report.status);

    const duplicate = store.readEvents(runId).some((candidate) =>
      candidate.type === 'provider-auth-required'
      && candidate.provider === provider
      && candidate.authFailureId === report.status.authFailureId);
    if (!duplicate) {
      store.appendEvent(runId, {
        type: 'provider-auth-required',
        provider,
        authFailureId: report.status.authFailureId,
        ...(event.stepId ? { stepId: event.stepId } : {}),
      });
    }
  };

  store.on('event', onEvent);
  return () => store.off('event', onEvent);
}

/**
 * Process-wide dedupe for store observation. The same boot store is wired
 * before recovery and again when the HTTP app is constructed; lazy stores are
 * wired both at creation and at the existing context-built hook. One listener
 * per RunStore keeps those lifecycle overlaps harmless.
 */
export class ProviderRuntimeAuthObserver {
  private readonly watched = new WeakSet<RunStore>();

  constructor(
    private readonly providerAuth: ProviderAuthService,
    private readonly onInvalidated: (status: ProviderStatus) => void,
  ) {}

  watch(store: RunStore): void {
    if (this.watched.has(store)) return;
    this.watched.add(store);
    watchProviderRuntimeAuthFailures(store, this.providerAuth, this.onInvalidated);
  }
}

/**
 * Boot ordering seam: observation must exist before recovery starts because a
 * resumed runner can emit its first normalized error before recover() returns.
 */
export async function recoverWithProviderRuntimeAuthObservation(
  store: RunStore,
  recover: () => Promise<void>,
  observer: ProviderRuntimeAuthObserver,
): Promise<void> {
  observer.watch(store);
  await recover();
}

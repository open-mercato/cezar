import {
  isRuntimeProviderAuthFailure,
  type ProviderAuthService,
  type ProviderId,
  type ProviderStatus,
} from '../core/provider-auth.ts';
import type { RunEvent, RunStore } from '../runs/store.ts';

const AUTH_ERROR_EVENT_TYPES = new Set(['error', 'session.error', 'note']);

/**
 * Watch a run store for the vendor errors that mean "your credentials were rejected", latch the
 * provider, and — because the latch is only ever as good as the pattern match that raised it —
 * immediately ask the provider's own CLI whether it was true.
 *
 * `onProviderStatus` carries BOTH edges: the invalidation, and the recovery when the self-check
 * finds the credentials were never gone. One callback rather than two on purpose — every caller
 * wires it to the same `provider-status` fan-out, and the cockpit already folds a `connected` row
 * over a latched one (`applyProviderStatusRow` drops the stale incident id), so recovery needs no
 * new wiring at any of the observer's construction sites.
 */
export function watchProviderRuntimeAuthFailures(
  store: RunStore,
  providerAuth: ProviderAuthService,
  onProviderStatus: (status: ProviderStatus) => void,
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
    if (report.transitioned) onProviderStatus(report.status);

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

    // The self-check rides the LATCH EDGE, not every matching line: the second and third auth-shaped
    // error of one failing run describe the incident already standing, and re-asking the CLI about it
    // would only spend spawns on an answer we have. The service's own cooldown backstops the case the
    // edge cannot see — a rejection that re-latches right after a successful recovery.
    if (!report.transitioned) return;
    void providerAuth.verifyRuntimeAuthFailure(provider).then(
      (recovered) => { if (recovered) onProviderStatus(recovered); },
      // A self-check that cannot run leaves the latch exactly as it found it. That is the behavior
      // this whole path had before it existed, and Settings' Try again is still there.
      () => {},
    );
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
    private readonly onProviderStatus: (status: ProviderStatus) => void,
  ) {}

  watch(store: RunStore): void {
    if (this.watched.has(store)) return;
    this.watched.add(store);
    watchProviderRuntimeAuthFailures(store, this.providerAuth, this.onProviderStatus);
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

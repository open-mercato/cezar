import type { AutomationDefinition, AutomationRuntimeState } from './types.ts';
import type { AutomationStore } from './store.ts';

export class LeaseHeldError extends Error {
  constructor() { super('automation polling lease is held by another process'); }
}

/** One lease/eligibility/launch/checkpoint protocol for every event provider. */
export async function runEventPollCycle<C extends { timestamp: string }, R extends { candidates: C[] }>(input: {
  store: AutomationStore;
  definition: AutomationDefinition;
  mode: 'preview' | 'execute';
  scheduled?: boolean;
  poll: (state: AutomationRuntimeState) => Promise<R>;
  /** Runs under the snapshot mutation lease, only for a current execute cycle. */
  prepareState?: (state: AutomationRuntimeState) => void;
  eligible?: (candidate: C, state: AutomationRuntimeState) => boolean;
  isCurrent?: () => Promise<boolean>;
  launch?: (candidate: C) => Promise<void>;
  persist: (result: R, current: AutomationRuntimeState) => AutomationRuntimeState;
  onChange?: (id: string, revision: number) => void;
}): Promise<R> {
  const { store, definition, mode } = input;
  const lease = store.acquireLease();
  if (!lease) {
    const error = new LeaseHeldError();
    store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: error.message });
    if (input.scheduled ?? mode === 'execute') {
      store.setState(definition.id, current => ({
        ...current, nextCheckAt: new Date(Date.now() + (definition.intervalSeconds ?? 60) * 1000).toISOString(),
      }));
      input.onChange?.(definition.id, definition.revision);
    }
    throw error;
  }
  const started = Date.now();
  let capturedState: AutomationRuntimeState | undefined;
  const current = () => {
    const found = store.get(definition.id);
    const latestState = store.state(definition.id) ?? {};
    return capturedState !== undefined
      && found?.revision === definition.revision
      && found.enabled === definition.enabled
      && latestState.baselineAt === capturedState.baselineAt
      && latestState.revision === capturedState.revision;
  };
  try {
    const snapshotLease = store.acquireMutationLease();
    if (!snapshotLease) throw new Error('automation mutation conflict');
    try {
      capturedState = store.state(definition.id) ?? {};
      if (mode === 'execute' && current() && input.prepareState) {
        input.prepareState(capturedState);
        capturedState = store.state(definition.id) ?? {};
      }
    } finally {
      snapshotLease.release();
    }
    const state = capturedState;
    if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
      throw new Error(`automation is backed off until ${state.backoffUntil}`);
    }
    const result = await input.poll(state);
    const eligible = result.candidates.filter(candidate =>
      (!state.baselineAt || candidate.timestamp > state.baselineAt)
      && (!input.eligible || input.eligible(candidate, state)),
    );
    if (mode === 'execute') {
      for (const candidate of eligible) {
        const mutation = store.acquireMutationLease();
        if (!mutation) throw new Error('automation mutation conflict');
        try {
          if (!current() || (input.isCurrent && !await input.isCurrent())) {
            return { ...result, candidates: [] };
          }
          await input.launch?.(candidate);
        } finally {
          mutation.release();
        }
      }
      const mutation = store.acquireMutationLease();
      if (!mutation) throw new Error('automation mutation conflict');
      try {
        if (current() && (!input.isCurrent || await input.isCurrent())) {
          store.setState(definition.id, state => input.persist(result, state));
        }
      } finally {
        mutation.release();
      }
    }
    store.appendLog({
      automationId: definition.id,
      revision: definition.revision,
      result: mode === 'preview' ? 'preview' : 'no-match',
      reason: mode === 'preview'
        ? `Bounded preview found ${eligible.length} match${eligible.length === 1 ? '' : 'es'}; no tasks were launched.`
        : 'Scheduled check completed.',
      durationMs: Date.now() - started,
    });
    input.onChange?.(definition.id, definition.revision);
    return { ...result, candidates: eligible };
  } catch (error) {
    const mutation = store.acquireMutationLease();
    try {
      if (mutation && mode === 'execute' && current()) {
        store.setState(definition.id, state => {
          const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
          const delay = Math.min(21_600_000, 60_000 * 2 ** (consecutiveFailures - 1));
          const nextCheckAt = new Date(Date.now() + delay).toISOString();
          return { ...state, consecutiveFailures, nextCheckAt, backoffUntil: nextCheckAt };
        });
      }
    } finally {
      mutation?.release();
    }
    store.appendLog({
      automationId: definition.id,
      revision: definition.revision,
      result: 'error',
      reason: error instanceof Error ? error.message : String(error),
    });
    input.onChange?.(definition.id, definition.revision);
    throw error;
  } finally {
    try {
      store.maybeCompact();
    } catch {
      // Retry maintenance next cycle.
    }
    lease.release();
  }
}

/** Durable event reservation is shared too; facades supply only provider payload/log fields. */
export async function launchEventCandidate(input: {
  store: AutomationStore;
  definition: AutomationDefinition;
  receipt: Omit<Parameters<AutomationStore['reserveReceipt']>[0], 'automationId' | 'revision'>;
  log: Pick<import('./types.ts').AutomationLogRecord, 'event' | 'githubNumber' | 'githubTitle' | 'githubUrl' | 'trackerKey' | 'trackerTitle' | 'trackerUrl'>;
  launch: (receiptId: string) => Promise<{ runId: string }>;
}): Promise<void> {
  const { store, definition } = input;
  const identity = { automationId: definition.id, revision: definition.revision };
  const receipt = store.reserveReceipt({ ...identity, ...input.receipt });
  if (!receipt) {
    store.appendLog({
      ...identity, ...input.log, result: 'duplicate',
      reason: 'A durable receipt already exists for this automation and event.',
    });
    return;
  }
  try {
    const launched = await input.launch(receipt.receiptId);
    store.appendReceipt({ ...receipt, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
    store.appendLog({ ...identity, ...input.log, result: 'launched', receiptId: receipt.receiptId, runId: launched.runId });
  } catch (error) {
    store.appendReceipt({
      ...receipt, status: 'launch-error',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

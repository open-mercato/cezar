import { THREAD_CONTINUATION_LIMIT, type ThreadDecision, type ThreadHygiene } from '@open-mercato/cezar-contract';

/** Count accepted work resumptions, never provider sessions or cumulative token usage. */
export function threadAdmission(current: ThreadHygiene | undefined, reason: string, operationId: string, decision?: ThreadDecision): { accepted: boolean; replayed?: boolean; state: ThreadHygiene } {
  const state: ThreadHygiene = current ?? { continuations: 0, historyKnown: false };
  if (state.lastOperationId === operationId || state.operationIds?.includes(operationId)) return { accepted: true, replayed: true, state };
  const approved = decision?.expectedCount === state.continuations;
  if (state.continuations >= THREAD_CONTINUATION_LIMIT && !approved) {
    return { accepted: false, state: { ...state, pending: state.pending ?? { reason, since: new Date().toISOString() } } };
  }
  return { accepted: true, state: {
    continuations: state.continuations + 1, historyKnown: state.historyKnown,
    operationIds: [...(state.operationIds ?? []), operationId],
    lastOperationId: operationId, lastReason: decision?.action === 'handoff' ? 'prepare-handoff' : reason,
  } };
}

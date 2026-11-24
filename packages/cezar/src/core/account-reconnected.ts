import type { ProviderId, ReconnectResumed } from '@open-mercato/cezar-contract';

/**
 * In-process seam between "an agent account is signed in again" (login sessions, Check again,
 * Settings' Connect watcher) and "resume what was blocked on it" (spec
 * 2026-11-18-inline-account-reconnect). The emitter never knows who resumes; the resumer never
 * knows how the login happened.
 */
export interface AccountReconnected {
  provider: ProviderId;
  /** `default` for the discovered login. */
  profileId: string;
}

export type AccountReconnectedListener = (event: AccountReconnected) => Promise<ReconnectResumed> | ReconnectResumed;

const listeners = new Set<AccountReconnectedListener>();

/** Subscribe; returns an unsubscribe. */
export function onAccountReconnected(listener: AccountReconnectedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Runs every listener and merges what they resumed. A throwing listener resumes nothing. */
export async function emitAccountReconnected(event: AccountReconnected): Promise<ReconnectResumed> {
  const merged: ReconnectResumed = { runs: [], managers: [] };
  for (const listener of [...listeners]) {
    try {
      const resumed = await listener(event);
      merged.runs.push(...resumed.runs);
      merged.managers.push(...resumed.managers);
    } catch {
      // One resumer failing must not hide what the others restarted.
    }
  }
  return merged;
}

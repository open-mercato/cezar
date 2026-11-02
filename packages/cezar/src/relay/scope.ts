import { AsyncLocalStorage } from 'node:async_hooks';
import type { Capabilities } from '@open-mercato/cezar-contract';

/**
 * The relay principal (spec 2026-11-01-relay-qr-pairing § Authorization). A decrypted OPEN runs
 * inside this scope, so a relay request is a hosted request even on a laptop. No header creates it.
 */
export interface RelayScope {
  deviceId: string;
}

const storage = new AsyncLocalStorage<RelayScope>();

export const inRelayScope = (): boolean => storage.getStore() !== undefined;

export const runInRelayScope = <T>(scope: RelayScope, fn: () => T): T => storage.run(scope, fn);

/** Work that outlives a request reads the unscoped value, as if the desktop had started it. */
export const outsideRelayScope = <T>(fn: () => T): T => storage.exit(fn);

/** The one place capabilities narrow; `createApp`'s `capabilities()` closure routes through it. */
export function narrowForRelay(capabilities: Capabilities): Capabilities {
  if (!inRelayScope()) return capabilities;
  return {
    ...capabilities,
    localHandoff: false,
    terminal: false,
    designMode: false,
    managerSystemNotifications: false,
    phonePairing: false,
  };
}

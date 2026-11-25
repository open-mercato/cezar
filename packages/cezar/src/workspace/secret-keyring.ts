/**
 * The OS keychain stores one item per initialized home: the 32-byte data key for its
 * secret files (spec 2026-10-10-project-secrets-vault-options, backend D). The secrets
 * themselves never go to the keychain — one item avoids per-secret access prompts per
 * binary, no per-platform value-size limit, and the metadata (scope, audiences) stays in the
 * file where it can be read without a prompt.
 *
 * Reached through `@napi-rs/keyring`, an OPTIONAL native dependency: a platform npm has no
 * prebuilt for, an install that skipped optional packages, or a machine without a usable store
 * all resolve to `null` here, and `SecretStore` falls back to a `0600` key file. The fallback is
 * a working cockpit, never a boot failure, and the store reports which backend it is using.
 *
 * Linux is pinned to Secret Service (gnome-keyring, KWallet, …). The library's default would
 * otherwise fall back to the kernel keyutils store, which does not survive a reboot — a data key
 * kept there would take every secret with it on the next restart.
 */

import { handoffKeyring } from './secret-handoff.ts';

export interface DataKeyring {
  /** The stored data key, or `null` when none was ever stored. Throws when the store is locked. */
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
}

/** The keychain item's coordinates. Legacy item, shared by every `CEZ_HOME`; new homes use a persisted account suffix. */
export const KEYCHAIN_SERVICE = 'cezar';
export const KEYCHAIN_ACCOUNT = 'secrets-data-key';

export type KeychainStatus = { keyring: DataKeyring } | { keyring: null; reason: string };

/** The platform package `@napi-rs/keyring` needs on this machine, for the "missing package" message. */
export function keyringPlatformPackage(platform = process.platform, arch = process.arch): string {
  if (platform === 'darwin') return `@napi-rs/keyring-darwin-${arch}`;
  if (platform === 'win32') return `@napi-rs/keyring-win32-${arch}-msvc`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return `@napi-rs/keyring-${platform}-${arch}-${report?.header?.glibcVersionRuntime ? 'gnu' : 'musl'}`;
}

/**
 * The OS keychain with the reason it is absent: disabled by `CEZ_SECRETS_KEYCHAIN=0` or a test
 * run, the native module failing to load (a node_modules installed on another OS), or no usable
 * store on this machine. A locked or refused store is not decided here: it throws from `get`.
 */
export async function keychainStatus(env: NodeJS.ProcessEnv = process.env, account = KEYCHAIN_ACCOUNT): Promise<KeychainStatus> {
  const handed = handoffKeyring(env);
  if (handed) return handed;
  if (env.CEZ_SECRETS_KEYCHAIN === '0') return { keyring: null, reason: 'the keychain is disabled by CEZ_SECRETS_KEYCHAIN=0' };
  if (env.VITEST || process.env.VITEST) return { keyring: null, reason: 'the keychain is not used in a test run' };
  let keyring: typeof import('@napi-rs/keyring');
  try {
    keyring = await import('@napi-rs/keyring');
  } catch {
    return {
      keyring: null,
      reason: `the native keychain module @napi-rs/keyring failed to load, most likely because ${keyringPlatformPackage()} is not installed for ${process.platform}-${process.arch} (node_modules installed on another OS?) — run npm install on this machine`,
    };
  }
  let entry: InstanceType<typeof keyring.AsyncEntry>;
  try {
    // Requiring a store makes the constructor throw when it is unavailable — the `null` below —
    // instead of silently picking the non-persistent kernel keyring.
    entry = new keyring.AsyncEntry(KEYCHAIN_SERVICE, account, { linux: { store: 'secret-service' } });
  } catch {
    return { keyring: null, reason: 'this machine has no usable OS keychain service' };
  }
  return {
    keyring: {
      async get() {
        const stored = await entry.getPassword();
        if (stored === null) return null;
        const key = Buffer.from(stored, 'base64');
        // Anything but a 32-byte key is not ours: treat it as absent rather than decrypt with it.
        return key.length === 32 ? key : null;
      },
      async set(key) {
        await entry.setPassword(key.toString('base64'));
      },
    },
  };
}

/** The OS keychain, or `null` when it is not to be used here; `keychainStatus` says why. */
export async function osKeychain(env: NodeJS.ProcessEnv = process.env, account = KEYCHAIN_ACCOUNT): Promise<DataKeyring | null> {
  return (await keychainStatus(env, account)).keyring;
}

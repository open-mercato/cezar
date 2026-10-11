/**
 * The OS keychain as a home for ONE item: the 32-byte data key that encrypts this machine's
 * secret files (spec 2026-10-10-project-secrets-vault-options, backend D). The secrets
 * themselves never go to the keychain — one item means one macOS "allow access" prompt per
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

export interface DataKeyring {
  /** The stored data key, or `null` when none was ever stored. Throws when the store is locked. */
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
}

/** The keychain item's coordinates. One per machine, shared by every `CEZ_HOME`. */
export const KEYCHAIN_SERVICE = 'cezar';
export const KEYCHAIN_ACCOUNT = 'secrets-data-key';

/**
 * The OS keychain, or `null` when it is not to be used here: `CEZ_SECRETS_KEYCHAIN=0`, a test
 * run (a vitest worker must never write a developer's real keychain — tests inject a fake), a
 * missing native package, or no usable store on this machine.
 */
export async function osKeychain(env: NodeJS.ProcessEnv = process.env): Promise<DataKeyring | null> {
  if (env.CEZ_SECRETS_KEYCHAIN === '0' || env.VITEST) return null;
  let keyring: typeof import('@napi-rs/keyring');
  try {
    keyring = await import('@napi-rs/keyring');
  } catch {
    return null;
  }
  let entry: InstanceType<typeof keyring.AsyncEntry>;
  try {
    // Requiring a store makes the constructor throw when it is unavailable — the `null` below —
    // instead of silently picking the non-persistent kernel keyring.
    entry = new keyring.AsyncEntry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, { linux: { store: 'secret-service' } });
  } catch {
    return null;
  }
  return {
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
  };
}

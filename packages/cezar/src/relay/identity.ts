import { hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { osKeychain, type DataKeyring } from '../workspace/secret-keyring.ts';
import { x25519Public } from './noise.ts';
import { edPublic, relayId } from './wire.ts';

/**
 * cezar's relay identity (spec § Keys). One 32-byte root per home, in the OS keychain with a `0600`
 * file fallback; the Ed25519 seed and X25519 secret derive from it, so `DataKeyring`'s one item
 * covers both. Created on the first Connect a phone click, never at boot.
 */

const KEY_FILE = '.key';
const ACCOUNT_FILE = '.keychain-account';
const KEYCHAIN_ACCOUNT_PREFIX = 'relay-identity';
const SALT = Buffer.from('cezar-relay-identity-v1', 'ascii');

export interface RelayIdentity {
  edSeed: Buffer;
  edPublic: Buffer;
  x25519Secret: Buffer;
  x25519Public: Buffer;
  cezarId: string;
}

/** The keychain holds the key but will not hand it over. Boot continues, Settings says so. */
export class RelayKeysLocked extends Error {}

const derive = (root: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync('sha256', root, SALT, Buffer.from(info, 'ascii'), 32));

export function identityFromRoot(root: Buffer): RelayIdentity {
  const edSeed = derive(root, 'ed25519');
  const x25519Secret = derive(root, 'x25519');
  const publicKey = edPublic(edSeed);
  return { edSeed, edPublic: publicKey, x25519Secret, x25519Public: x25519Public(x25519Secret), cezarId: relayId(publicKey) };
}

export class RelayIdentityStore {
  private cached: RelayIdentity | undefined;

  constructor(
    private readonly directory: string,
    private readonly keychain: (account: string) => Promise<DataKeyring | null> = (account) => osKeychain(process.env, account),
  ) {}

  /** The saved identity, or `null` when no click ever created one. */
  async load(): Promise<RelayIdentity | null> {
    if (this.cached) return this.cached;
    const root = await this.readRoot();
    if (!root) return null;
    this.cached = identityFromRoot(root);
    return this.cached;
  }

  async ensure(): Promise<RelayIdentity> {
    const loaded = await this.load();
    if (loaded) return loaded;
    const root = randomBytes(32);
    const keychain = await this.keychainFor(true);
    let stored = false;
    if (keychain) {
      try {
        await keychain.set(root);
        stored = true;
      } catch {
        // A locked or refusing store falls back to the file, like the secrets vault.
      }
    }
    if (!stored) await this.writePrivate(KEY_FILE, root.toString('base64'));
    this.cached = identityFromRoot(root);
    return this.cached;
  }

  private async readRoot(): Promise<Buffer | null> {
    const text = await fs.readFile(join(this.directory, KEY_FILE), 'utf8').catch(() => null);
    if (text !== null) {
      const root = Buffer.from(text.trim(), 'base64');
      if (root.length === 32) return root;
    }
    const keychain = await this.keychainFor(false);
    if (!keychain) return null;
    try {
      return await keychain.get();
    } catch (error) {
      throw new RelayKeysLocked(error instanceof Error ? error.message : 'the OS keychain is locked');
    }
  }

  private async keychainFor(create: boolean): Promise<DataKeyring | null> {
    const path = join(this.directory, ACCOUNT_FILE);
    let id = (await fs.readFile(path, 'utf8').catch(() => '')).trim();
    if (!id) {
      if (!create) return null;
      id = randomUUID();
      await this.writePrivate(ACCOUNT_FILE, id);
    }
    return this.keychain(`${KEYCHAIN_ACCOUNT_PREFIX}:${id}`);
  }

  private async writePrivate(name: string, text: string): Promise<void> {
    const path = join(this.directory, name);
    assertCezarHomeWriteIsSandboxed(path);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path, `${text}\n`, { mode: 0o600 });
    await fs.chmod(path, 0o600);
  }
}

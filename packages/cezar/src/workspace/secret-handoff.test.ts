import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoffKeyring, HANDOFF_ENV, resetHandoffForTests } from './secret-handoff.ts';
import { keychainStatus } from './secret-keyring.ts';
import { SecretStore } from './secrets.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('handoffKeyring', () => {
  afterEach(() => resetHandoffForTests());

  it('is absent when no handoff is configured', () => {
    expect(handoffKeyring({}, () => { throw new Error('must not read'); })).toBeNull();
  });

  it('loads the key once and removes the path from the environment', async () => {
    const env: NodeJS.ProcessEnv = { [HANDOFF_ENV]: '/run/h/data-key' };
    let reads = 0;
    const got = handoffKeyring(env, () => { reads += 1; return `${KEY}\n`; });
    expect(env[HANDOFF_ENV]).toBeUndefined();
    expect(await (got as { keyring: { get(): Promise<Buffer> } }).keyring.get()).toEqual(Buffer.alloc(32, 7));
    handoffKeyring({}, () => { reads += 1; return KEY; });
    expect(reads).toBe(1);
  });

  it('refuses an unreadable or wrong-sized handoff without falling back', () => {
    expect(handoffKeyring({ [HANDOFF_ENV]: '/x' }, () => { throw new Error('EACCES'); })).toMatchObject({ keyring: null, reason: expect.stringContaining('cannot be read') });
    resetHandoffForTests();
    expect(handoffKeyring({ [HANDOFF_ENV]: '/x' }, () => 'c2hvcnQ=')).toMatchObject({ keyring: null, reason: expect.stringContaining('32-byte') });
  });

  it('is read-only', async () => {
    const got = handoffKeyring({ [HANDOFF_ENV]: '/x' }, () => KEY) as { keyring: { set(k: Buffer): Promise<void> } };
    await expect(got.keyring.set(Buffer.alloc(32))).rejects.toThrow(/read-only/);
  });
});

describe('the handoff as the secret store sees it', () => {
  afterEach(() => resetHandoffForTests());

  it('is the keychain-class backend, so resolve needs no --allow-file-key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    const env: NodeJS.ProcessEnv = { CEZ_HOME: home, [HANDOFF_ENV]: '/x' };
    handoffKeyring(env, () => KEY);
    const store = new SecretStore({ CEZ_HOME: home }, { keychain: async () => (await keychainStatus({ ...env, [HANDOFF_ENV]: '/x' })).keyring });
    expect(await store.keyBackend()).toBe('keychain');
  });
});

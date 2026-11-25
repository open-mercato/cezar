import { afterEach, describe, expect, it, vi } from 'vitest';
import { keychainStatus, keyringPlatformPackage } from './secret-keyring.ts';

describe('keychainStatus', () => {
  const vitest = process.env.VITEST;
  afterEach(() => {
    process.env.VITEST = vitest;
    vi.doUnmock('@napi-rs/keyring');
    vi.resetModules();
  });

  it('says the keychain is disabled by CEZ_SECRETS_KEYCHAIN=0', async () => {
    const status = await keychainStatus({ CEZ_SECRETS_KEYCHAIN: '0' });
    expect(status).toMatchObject({ keyring: null, reason: expect.stringContaining('CEZ_SECRETS_KEYCHAIN=0') });
  });

  it('names the platform package when the native module fails to import', async () => {
    delete process.env.VITEST;
    vi.doMock('@napi-rs/keyring', () => { throw new Error('Cannot find native binding'); });
    const status = await keychainStatus({});
    expect(status).toMatchObject({ keyring: null, reason: expect.stringContaining(keyringPlatformPackage()) });
  });

  it('says no usable store when the entry cannot be created', async () => {
    delete process.env.VITEST;
    vi.doMock('@napi-rs/keyring', () => ({ AsyncEntry: class { constructor() { throw new Error('no store'); } } }));
    expect(await keychainStatus({})).toMatchObject({ keyring: null, reason: expect.stringContaining('no usable OS keychain') });
  });

  it('keeps a locked store distinct: get throws instead of the keychain going absent', async () => {
    delete process.env.VITEST;
    vi.doMock('@napi-rs/keyring', () => ({ AsyncEntry: class { getPassword() { return Promise.reject(new Error('locked')); } } }));
    const status = await keychainStatus({});
    expect(status.keyring).not.toBeNull();
    await expect(status.keyring!.get()).rejects.toThrow('locked');
  });

  it('maps darwin to its own package', () => {
    expect(keyringPlatformPackage('darwin', 'arm64')).toBe('@napi-rs/keyring-darwin-arm64');
  });
});

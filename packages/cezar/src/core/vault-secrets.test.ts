import { describe, expect, it } from 'vitest';
import { cachingVaultReader, isVaultRef, parseVaultRef, type VaultRef } from './vault-secrets.ts';
import { resolvePassthrough, resolveSecretEnv } from './credential-passthrough.ts';

describe('vault references', () => {
  it('parses mount, path and field, including nested paths', () => {
    expect(parseVaultRef('vault://secret/dev/textbookweb#STRIPE_KEY')).toEqual({
      mount: 'secret',
      path: 'dev/textbookweb',
      field: 'STRIPE_KEY',
    });
    expect(parseVaultRef('vault://kv/app#token')).toEqual({ mount: 'kv', path: 'app', field: 'token' });
  });

  it('refuses anything that would reach `vault` as something other than a path', () => {
    // Every part becomes an argv entry. A reference that parsed loosely would
    // surface as vault's own error about a malformed path rather than as a bad
    // reference the operator can see and fix.
    for (const bad of [
      'vault://secret/dev/app',            // no field
      'vault://secret/dev/app#',           // empty field
      'vault://secret#field',              // no path
      'vault:///dev/app#f',                // no mount
      'vault://secret/../../etc#f',        // traversal
      'vault://secret/dev//app#f',         // empty segment
      'vault://-flag/dev#f',               // leading dash in mount
      'vault://secret/dev/app#-format',    // a field that reads as a flag
      'op://vault/item/field',             // another store's syntax
      'https://example.com/x#y',
    ]) {
      expect(parseVaultRef(bad), bad).toBeNull();
    }
  });

  it('recognizes its own scheme and nothing else', () => {
    expect(isVaultRef('vault://a/b#c')).toBe(true);
    expect(isVaultRef('ANTHROPIC_API_KEY')).toBe(false);
  });

  it('caches per reference for the TTL, then asks again', async () => {
    // A multi-step workflow re-resolves per turn; without this it would pay a
    // round trip per step for the same value.
    let calls = 0;
    const inner = async (_ref: VaultRef): Promise<string> => { calls += 1; return `v${calls}`; };
    const read = cachingVaultReader(inner, 50);
    const ref = parseVaultRef('vault://secret/a#b')!;
    expect(await read(ref)).toBe('v1');
    expect(await read(ref)).toBe('v1');
    expect(calls).toBe(1);
    // A different reference is a different entry.
    await read(parseVaultRef('vault://secret/a#other')!);
    expect(calls).toBe(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(await read(ref)).toBe('v3');
  });
});

describe('fetching a credential value', () => {
  const HOME = '/Users/k';
  const selection = (over: Record<string, unknown> = {}) => resolvePassthrough({
    custom: [{
      id: 'stripe',
      env: ['STRIPE_API_KEY'],
      valueFrom: 'vault://secret/dev/api#stripe',
      ...over,
    }],
  }, HOME, () => true);

  it('injects the fetched value under every name the credential lists', async () => {
    const { pairs, problems } = await resolveSecretEnv(selection(), async () => 'sk_live_abcdefghijkl');
    expect(pairs).toEqual(['STRIPE_API_KEY=sk_live_abcdefghijkl']);
    expect(problems).toEqual([]);
  });

  it('never injects an EMPTY value when the fetch fails', async () => {
    // An empty value shadows a credential the container already holds.
    const failed = await resolveSecretEnv(selection(), async () => { throw new Error('permission denied'); });
    expect(failed.pairs).toEqual([]);
    expect(failed.problems[0]).toMatchObject({ id: 'stripe', reason: 'permission denied', required: false });

    const empty = await resolveSecretEnv(selection(), async () => '');
    expect(empty.pairs).toEqual([]);
    expect(empty.problems[0]?.reason).toMatch(/empty value/);
  });

  it('marks a load-bearing secret so the caller fails the step', async () => {
    const { problems } = await resolveSecretEnv(selection({ required: true }), async () => {
      throw new Error('vault is sealed');
    });
    expect(problems[0]).toMatchObject({ required: true, reason: 'vault is sealed' });
  });

  it('does not read a fetched credential from the host environment', async () => {
    // Forwarding the host's value too would silently prefer a stale local
    // export over the store the operator pointed at.
    const { credentialEnvPairs } = await import('./credential-passthrough.ts');
    expect(credentialEnvPairs(selection(), { STRIPE_API_KEY: 'stale-local-value' })).toEqual([]);
  });

  it('leaves ordinary credentials alone', async () => {
    const plain = resolvePassthrough({ custom: [{ id: 'x', env: ['PLAIN'] }] }, HOME, () => true);
    const { pairs, problems } = await resolveSecretEnv(plain, async () => { throw new Error('must not run'); });
    expect(pairs).toEqual([]);
    expect(problems).toEqual([]);
  });
});

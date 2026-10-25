import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  parseBasicAuth,
  safeEqualString,
  verifyPassword,
} from './auth-crypto.ts';

describe('auth-crypto', () => {
  describe('hashPassword and verifyPassword', () => {
    it('successfully verifies a valid password round trip', async () => {
      const stored = await hashPassword('correct horse battery staple');
      expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(stored.hash).toMatch(/^[0-9a-f]{128}$/);

      const isValid = await verifyPassword('correct horse battery staple', stored);
      expect(isValid).toBe(true);
    });

    it('returns false when password does not match', async () => {
      const stored = await hashPassword('password123');
      const isValid = await verifyPassword('wrongpassword', stored);
      expect(isValid).toBe(false);
    });

    it('generates distinct salts and hashes for identical passwords', async () => {
      const first = await hashPassword('same-password');
      const second = await hashPassword('same-password');

      expect(first.salt).not.toBe(second.salt);
      expect(first.hash).not.toBe(second.hash);
      expect(await verifyPassword('same-password', first)).toBe(true);
      expect(await verifyPassword('same-password', second)).toBe(true);
    });

    it('returns false without throwing on malformed or invalid stored values', async () => {
      const valid = await hashPassword('test');

      // Non-hex characters
      expect(await verifyPassword('test', { salt: 'z'.repeat(32), hash: valid.hash })).toBe(false);
      expect(await verifyPassword('test', { salt: valid.salt, hash: 'x'.repeat(128) })).toBe(false);

      // Wrong length
      expect(await verifyPassword('test', { salt: valid.salt.slice(0, 16), hash: valid.hash })).toBe(false);
      expect(await verifyPassword('test', { salt: valid.salt, hash: valid.hash.slice(0, 64) })).toBe(false);
      expect(await verifyPassword('test', { salt: valid.salt + 'aa', hash: valid.hash })).toBe(false);

      // Empty or invalid types
      expect(await verifyPassword('test', { salt: '', hash: '' })).toBe(false);
      expect(await verifyPassword('test', null as any)).toBe(false);
      expect(await verifyPassword('test', undefined as any)).toBe(false);
      expect(await verifyPassword(123 as any, valid)).toBe(false);
    });
  });

  describe('parseBasicAuth', () => {
    it('parses basic auth header correctly', () => {
      const b64 = Buffer.from('alex:super-secret').toString('base64');
      const parsed = parseBasicAuth(`Basic ${b64}`);
      expect(parsed).toEqual({ username: 'alex', password: 'super-secret' });
    });

    it('handles passwords containing colons', () => {
      const b64 = Buffer.from('admin:pass:with:colons:inside').toString('base64');
      const parsed = parseBasicAuth(`Basic ${b64}`);
      expect(parsed).toEqual({ username: 'admin', password: 'pass:with:colons:inside' });
    });

    it('is case-insensitive with the scheme', () => {
      const b64 = Buffer.from('user:pass').toString('base64');
      expect(parseBasicAuth(`basic ${b64}`)).toEqual({ username: 'user', password: 'pass' });
      expect(parseBasicAuth(`BASIC ${b64}`)).toEqual({ username: 'user', password: 'pass' });
    });

    it('handles unicode in credentials', () => {
      const b64 = Buffer.from('üser:pässwörd').toString('base64');
      expect(parseBasicAuth(`Basic ${b64}`)).toEqual({ username: 'üser', password: 'pässwörd' });
    });

    it('returns null on missing, invalid, or non-basic headers', () => {
      expect(parseBasicAuth(undefined)).toBeNull();
      expect(parseBasicAuth('')).toBeNull();
      expect(parseBasicAuth('Bearer some-token')).toBeNull();
      expect(parseBasicAuth('Basic')).toBeNull();
      expect(parseBasicAuth('Basic ')).toBeNull();
      expect(parseBasicAuth('Basic not_valid_base64!??')).toBeNull();

      // Base64 without a colon
      const noColon = Buffer.from('justapassword').toString('base64');
      expect(parseBasicAuth(`Basic ${noColon}`)).toBeNull();
    });
  });

  describe('safeEqualString', () => {
    it('returns true for identical strings', () => {
      expect(safeEqualString('alex', 'alex')).toBe(true);
      expect(safeEqualString('', '')).toBe(true);
      expect(safeEqualString('a very long username with symbols !@#$%^&*()', 'a very long username with symbols !@#$%^&*()')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(safeEqualString('alex', 'alex2')).toBe(false);
      expect(safeEqualString('alex', 'bob')).toBe(false);
      expect(safeEqualString('short', 'much longer string')).toBe(false);
      expect(safeEqualString('caseSensitive', 'casesensitive')).toBe(false);
    });

    it('returns false for non-string values', () => {
      expect(safeEqualString(null as any, 'alex')).toBe(false);
      expect(safeEqualString('alex', undefined as any)).toBe(false);
    });
  });
});

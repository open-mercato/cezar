import { describe, expect, it } from 'vitest';
import { isTrustedHostHeader, parseTrustedHosts, trustedHosts } from './trusted-hosts.ts';

describe('CEZ_TRUSTED_HOSTS', () => {
  it('parses empty, single, multi, whitespace and duplicate entries', () => {
    expect([...parseTrustedHosts(undefined)]).toEqual([]);
    expect([...parseTrustedHosts('')]).toEqual([]);
    expect([...parseTrustedHosts(' a.example ')]).toEqual(['a.example']);
    expect([...parseTrustedHosts('a.example,b.example:8445')].sort()).toEqual(['a.example', 'b.example:8445']);
    expect([...parseTrustedHosts('a.example, a.example ')]).toEqual(['a.example']);
  });

  it('keeps only the authority of a pasted URL and drops unparseable entries', () => {
    expect([...parseTrustedHosts('https://host.ts.net:8445/path')]).toEqual(['host.ts.net:8445']);
    expect([...parseTrustedHosts('http://[fd7a::1]:8443/')]).toEqual(['[fd7a::1]:8443']);
    expect([...parseTrustedHosts('://broken')]).toEqual([]);
  });

  it('never lets an empty entry, a wildcard or a near-miss name match', () => {
    const trusted = parseTrustedHosts('host.ts.net, ');
    expect(isTrustedHostHeader('', trusted)).toBe(false);
    expect(isTrustedHostHeader('host.ts.net.', trusted)).toBe(false); // trailing dot is a different authority
    const wildcard = parseTrustedHosts('*');
    expect(isTrustedHostHeader('anything.example', wildcard)).toBe(false);
    const portStrict = parseTrustedHosts('host.ts.net:8445');
    expect(isTrustedHostHeader('host.ts.net:443', portStrict)).toBe(false);
  });

  it('matches a Host by authority, case-insensitively, never partially', () => {
    const trusted = parseTrustedHosts('host.ts.net:8445');
    expect(isTrustedHostHeader('host.ts.net:8445', trusted)).toBe(true);
    expect(isTrustedHostHeader('HOST.ts.net:8445', trusted)).toBe(true);
    expect(isTrustedHostHeader('host.ts.net', trusted)).toBe(false); // port-less entry semantics
    expect(isTrustedHostHeader('evil-host.ts.net:8445', trusted)).toBe(false);
    expect(isTrustedHostHeader(undefined, trusted)).toBe(false);
    expect(isTrustedHostHeader('host.ts.net:8445', new Set())).toBe(false);
  });

  it('reads the environment live, memoized per raw value', () => {
    const saved = process.env.CEZ_TRUSTED_HOSTS;
    try {
      process.env.CEZ_TRUSTED_HOSTS = 'live.example';
      expect(trustedHosts().has('live.example')).toBe(true);
      process.env.CEZ_TRUSTED_HOSTS = '';
      expect(trustedHosts().size).toBe(0);
      delete process.env.CEZ_TRUSTED_HOSTS;
      expect(trustedHosts().size).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.CEZ_TRUSTED_HOSTS;
      else process.env.CEZ_TRUSTED_HOSTS = saved;
    }
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { apiOrigin } from './api-origin.ts';

describe('cockpit API origin', () => {
  it('uses the configured bind host and brackets IPv6 literals', () => {
    expect(apiOrigin(undefined, 4321)).toBe('http://127.0.0.1:4321');
    expect(apiOrigin('172.17.0.1', 4321)).toBe('http://172.17.0.1:4321');
    expect(apiOrigin('::1', 4321)).toBe('http://[::1]:4321');
    expect(apiOrigin('[::1]', 4321)).toBe('http://[::1]:4321');
  });

  it('dials loopback for a wildcard bind', () => {
    expect(apiOrigin('0.0.0.0', 4321)).toBe('http://127.0.0.1:4321');
    expect(apiOrigin('::', 4321)).toBe('http://[::1]:4321');
    expect(apiOrigin('[::]', 4321)).toBe('http://[::1]:4321');
  });

  it('keeps startup wired to the configured host', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("pickStartupPort(preferredPort, process.env.CEZ_REMOTE === '1', bindHost)");
    expect(source).toContain('apiOrigin(bindHost, port)');
  });
});

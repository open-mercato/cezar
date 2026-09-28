import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { apiOrigin, canListen, pickPort } from './api-origin.ts';

describe('cockpit API origin', () => {
  it('uses the configured bind host and brackets IPv6 literals', () => {
    expect(apiOrigin(undefined, 4321)).toBe('http://127.0.0.1:4321');
    expect(apiOrigin('172.17.0.1', 4321)).toBe('http://172.17.0.1:4321');
    expect(apiOrigin('::1', 4321)).toBe('http://[::1]:4321');
    expect(apiOrigin('[::1]', 4321)).toBe('http://[::1]:4321');
  });

  it('probes and selects ports on the configured interface', async () => {
    const nonLoopbackIpv4 = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    if (!nonLoopbackIpv4) return;

    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, nonLoopbackIpv4, resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('test server did not get a port');
    expect(await canListen(address.port, nonLoopbackIpv4)).toBe(false);
    expect(await canListen(address.port, '127.0.0.1')).toBe(true);
    const next = await pickPort(address.port, nonLoopbackIpv4);
    expect(next).toBeGreaterThan(address.port);
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    expect(await canListen(next, nonLoopbackIpv4)).toBe(true);
  });

  it('keeps startup wired to the configured host', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("pickStartupPort(preferredPort, process.env.CEZ_REMOTE === '1', bindHost)");
    expect(source).toContain('apiOrigin(bindHost, port)');
  });
});

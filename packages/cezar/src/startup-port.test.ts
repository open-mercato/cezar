import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { canListen, pickStartupPort } from './startup-port.ts';

describe('startup port selection', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it('keeps an occupied configured port authoritative in installed mode', async () => {
    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('test server did not get a port');

    expect(await canListen(address.port)).toBe(false);
    expect(await pickStartupPort(address.port, true)).toBe(address.port);

    const refused = createServer();
    const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      refused.once('error', resolve);
      refused.listen(address.port, '127.0.0.1');
    });
    expect(error?.code).toBe('EADDRINUSE');
  });

  it('preserves bounded auto-increment for interactive launches', async () => {
    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('test server did not get a port');

    const selected = await pickStartupPort(address.port, false);
    expect(selected).toBeGreaterThan(address.port);
    expect(await canListen(selected)).toBe(true);
  });

  it('probes and selects ports on the configured interface', async () => {
    const nonLoopbackIpv4 = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    if (!nonLoopbackIpv4) return;

    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, nonLoopbackIpv4, resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('test server did not get a port');
    expect(await canListen(address.port, nonLoopbackIpv4)).toBe(false);
    expect(await canListen(address.port, '127.0.0.1')).toBe(true);
    const next = await pickStartupPort(address.port, false, nonLoopbackIpv4);
    expect(next).toBeGreaterThan(address.port);
    expect(await canListen(next, nonLoopbackIpv4)).toBe(true);
  });
});

describe('listen errors', () => {
  it('turns EADDRINUSE on a taken port into a handled message, not an uncaught exception', async () => {
    const { createServer: createHttp } = await import('node:http');
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const second = createHttp();
    const { handleListenError } = await import('./startup-port.ts');
    const message = await new Promise<string>((resolve) => {
      handleListenError(second, address.port, resolve);
      second.listen(address.port, '127.0.0.1');
    });
    expect(message).toContain(`port ${address.port} is already in use`);
    expect(message).toContain('--port');
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
});

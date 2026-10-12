import { createServer } from 'node:net';
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
});

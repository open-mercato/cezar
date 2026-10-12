import { createServer } from 'node:net';

/**
 * Check whether the loopback port used by the local cockpit is available.
 * The server performs the authoritative bind after selection; this is only
 * the interactive convenience probe.
 */
export function canListen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    const finish = (available: boolean): void => {
      probe.removeAllListeners();
      resolve(available);
    };
    probe.once('error', () => finish(false));
    probe.once('listening', () => probe.close(() => finish(true)));
    probe.listen(port, host);
  });
}

/**
 * Select a port for startup. Installed services have a fixed proxy upstream,
 * so their configured port is authoritative and must reach the real bind.
 * Interactive launches retain the historical bounded auto-increment behavior.
 */
export async function pickStartupPort(
  start: number,
  strict: boolean,
  host = '127.0.0.1',
): Promise<number> {
  if (strict) return start;
  for (let port = start; port < start + 50; port++) {
    if (await canListen(port, host)) return port;
  }
  return start;
}

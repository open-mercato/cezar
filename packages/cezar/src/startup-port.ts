import { createServer } from 'node:net';

/**
 * Check availability on the interface the HTTP server will bind (#1000).
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

/** One human line for a failed bind, so a taken port never surfaces as an uncaught exception. */
export function listenErrorMessage(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === 'EADDRINUSE') {
    return `port ${port} is already in use by another process. Stop it, or start cezar on a free port with --port <n>.`;
  }
  if (error.code === 'EACCES') {
    return `no permission to listen on port ${port}. Pick another with --port <n>.`;
  }
  return `could not listen on port ${port}: ${error.message}`;
}

/** Route the server's 'error' event (EADDRINUSE and friends) to `onFatal` instead of letting it escape. */
export function handleListenError(
  server: { on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown },
  port: number,
  onFatal: (message: string) => void,
): void {
  server.on('error', (error) => onFatal(listenErrorMessage(error, port)));
}

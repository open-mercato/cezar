import { createServer } from 'node:net';

const DEFAULT_API_HOST = '127.0.0.1';

/** Build the URL inherited by agents from the interface the cockpit serves on. */
export function apiOrigin(host: string | undefined, port: number): string {
  const value = host ?? DEFAULT_API_HOST;
  const urlHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `http://${urlHost}:${port}`;
}

/** Check availability on the same interface that the HTTP server will bind. */
export function canListen(port: number, host = DEFAULT_API_HOST): Promise<boolean> {
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

/** First free port starting at `start`, on the requested interface. */
export async function pickPort(start: number, host?: string): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (await canListen(port, host)) return port;
  }
  return start;
}

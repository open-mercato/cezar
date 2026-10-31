const DEFAULT_API_HOST = '127.0.0.1';
// A wildcard bind is not a dialable address everywhere (Windows refuses 0.0.0.0); loopback reaches it.
const WILDCARD_DIAL_HOST = new Map([['0.0.0.0', '127.0.0.1'], ['::', '::1'], ['[::]', '::1']]);

/** Build the URL inherited by agents from the interface the cockpit serves on. */
export function apiOrigin(host: string | undefined, port: number): string {
  const value = (host && WILDCARD_DIAL_HOST.get(host)) ?? host ?? DEFAULT_API_HOST;
  const urlHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `http://${urlHost}:${port}`;
}

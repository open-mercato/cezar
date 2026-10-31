/**
 * How long an idle keep-alive socket stays open. Node's 5 s default is shorter than every
 * browser's idle pool (Chrome holds sockets 300 s), so the server closes a socket the browser
 * still considers reusable. WebKit does not retry a POST that dies on such a socket, and the
 * cockpit reported it as "cannot reach the cezar server" against a healthy server (telemetry
 * 7adbfbd7). Outliving the browser's pool means the BROWSER retires the socket, never us.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 310_000;

/** Apply the cockpit's keep-alive policy to the server `serve()` returned. An HTTP/2 server has
 *  no `keepAliveTimeout` (it multiplexes one session) and is left alone. */
export function applyKeepAlive(server: object): void {
  if ('keepAliveTimeout' in server) server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
}

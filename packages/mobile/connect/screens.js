// What each native outcome means to the person holding the phone (spec Decision 2). No DOM here.
export const NO_HTTP =
  'Plain http is refused, because your password would cross the network unencrypted. Reach cezar over https through ngrok, a Cloudflare Tunnel or tailscale serve.';

const MESSAGES = {
  'local-mode':
    'This cezar runs in local mode and refuses other hosts. Install it with cezar server-install, or start it with CEZ_REMOTE=1.',
  'tls-failure': 'This server\'s certificate is not valid, so the app will not connect. There is no way around this.',
  'not-cezar': 'This is not a cezar server.',
  'connection-error': 'Could not reach this server.',
  'cleartext-refused': NO_HTTP,
  'invalid-url': 'Enter the server address only, such as https://cezar.example.com, with no path or password.',
};

/** Turns a native outcome into the screen to draw. `context` is what the user last asked for. */
export function screenFor(outcome, context = {}) {
  const server = outcome.servers?.find((row) => row.id === (outcome.serverId ?? context.serverId));
  const url = server?.url ?? context.url;
  const status = outcome.status ? ` (status ${outcome.status})` : '';
  switch (outcome.screen) {
    case 'open':
    case 'login':
      return { name: 'busy' };
    case 'ask-credentials':
      return { name: 'credentials', url, username: server?.username ?? context.username ?? '' };
    case 'password-rejected':
      return { name: 'credentials', url, username: server?.username ?? context.username ?? '', notice: 'Password rejected.' };
    case 'connection-error':
    case 'tls-failure':
      return server
        ? { name: 'error', serverId: server.id, message: MESSAGES[outcome.screen] + status }
        : { name: 'add', url, notice: MESSAGES[outcome.screen] + status };
    case 'local-mode':
    case 'not-cezar':
    case 'cleartext-refused':
    case 'invalid-url':
      return { name: 'add', url, notice: MESSAGES[outcome.screen] + status };
    default:
      return outcome.servers?.length ? { name: 'list' } : { name: 'add' };
  }
}

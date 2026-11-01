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

const PAIR_FAILURES = {
  'not-found': 'Code not found or expired. Show a new code on your computer.',
  expired: 'This code has expired. Show a new code on your computer.',
  taken: 'Someone else already used this code, so pairing stopped. Show a new code on your computer and check that nobody else can see it.',
  'pin-mismatch': 'This does not look like your computer, so the app stopped. Show a new code and try again.',
  denied: 'Your computer denied this phone.',
  timeout: 'Pairing took too long. Show a new code on your computer.',
  cancelled: 'Pairing was cancelled.',
  contested: 'Someone else tried to use this code, so pairing stopped. Show a new code on your computer.',
  lost: 'Pairing failed: the connection ended. Show a new code on your computer.',
  'device-limit': 'This computer has too many paired phones. Remove one in Settings first.',
  'relay-error': 'The relay did not confirm this phone. Pairing failed, so try again.',
  'bad-payload': 'Your computer could not read this phone. Update the app.',
  'relay-unreachable': "Can't reach the Cezar relay. Your computer is fine. Check your connection and try again.",
  'relay-disabled': 'The Cezar relay is paused for now. Try again in a few minutes.',
  'rate-limited': 'Too many tries. Wait a while, then show a new code.',
  'update-app': 'Update the app.',
  'update-cezar': 'Update cezar on your computer.',
  'qr-invalid': 'This is not a cezar pairing code.',
  'qr-cleartext': 'This code points at an unencrypted relay, which this app refuses.',
  'code-invalid': 'Check the code: it has 12 letters and digits.',
  'relay-invalid': 'Enter the relay address shown beside the code on your computer.',
  'relay-cleartext': 'The relay address must start with https://.',
  internal: 'Pairing failed. Show a new code on your computer.',
};

const RELAY_SCREENS = {
  'cezar-offline': "Your computer is asleep or cezar isn't running.",
  'relay-down': "Can't reach the Cezar relay. Your computer is fine.",
  'update-app': 'Update the app.',
  'update-cezar': 'Update cezar on your computer.',
};

/** Turns a native outcome into the screen to draw. `context` is what the user last asked for. */
export function screenFor(outcome, context = {}) {
  const server = outcome.servers?.find((row) => row.id === (outcome.serverId ?? context.serverId));
  const url = server?.url ?? context.url;
  const status = outcome.status ? ` (status ${outcome.status})` : '';
  switch (outcome.screen) {
    case 'pair':
      if (outcome.phase === 'failed') return { name: 'pair-failed', message: PAIR_FAILURES[outcome.reason] ?? PAIR_FAILURES.internal };
      if (outcome.phase === 'confirm') return { name: 'pair-confirm', digits: outcome.digits, label: outcome.label, seq: outcome.seq };
      return { name: 'pair-waiting', seq: outcome.seq };
    case 'device-removed':
      return { name: 'removed', serverId: server?.id, label: server?.label };
    case 'quota':
      return { name: 'error', serverId: server?.id, message: `Too much traffic today. Back in ${outcome.status} minutes.` };
    case 'cezar-offline':
    case 'relay-down':
    case 'update-app':
    case 'update-cezar':
      return { name: 'error', serverId: server?.id, message: RELAY_SCREENS[outcome.screen] };
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
      if (outcome.servers?.length) return { name: 'list' };
      return { name: outcome.pairing ? 'start' : 'add' };
  }
}

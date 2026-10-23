import { DEFAULT_COCKPIT_URL } from './cockpit-address.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

/**
 * `cezar auth` — lockout recovery for LAN access (spec 2026-10-20-lan-basic-auth-https). Works on
 * `~/.cezar/config.json` directly, so it needs no server and no password: whoever can run it
 * already owns this machine's account.
 */

export interface AuthCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface AuthCommandDeps {
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
}

const defaultIo: AuthCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cezar auth [status]   show whether LAN access is on and who can sign in
  cezar auth reset      turn LAN access off and forget its username and password`;

export async function runAuthCommand(
  args: string[],
  io: AuthCommandIo = defaultIo,
  deps: AuthCommandDeps = {},
): Promise<number> {
  const [sub = 'status'] = args;
  if (sub === 'status') {
    const security = (await loadWorkspaceConfig()).security;
    io.log(`LAN access: ${security?.lanAccess ? 'on' : 'off'}`);
    io.log(`sign-in:    ${security?.auth ? `user "${security.auth.username}"` : 'not configured'}`);
    return 0;
  }
  if (sub === 'reset') {
    await mergeWriteWorkspaceConfig((config) => {
      delete config.security;
    });
    io.log('LAN access is off and its credentials are gone.');

    // When a local cockpit is already running, send it a loopback PUT to drop the LAN listener immediately.
    const apiUrl = deps.apiUrl ?? process.env.CEZ_API_URL ?? DEFAULT_COCKPIT_URL;
    const fetchFn = deps.fetch ?? globalThis.fetch;
    let notified = false;
    try {
      const res = await fetchFn(new URL('/api/v1/security/lan', apiUrl), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lanAccess: false }),
        signal: AbortSignal.timeout(1000),
      });
      if (res?.ok) notified = true;
    } catch {
      // Server not running or unreachable; that's fine, the config is cleared.
    }

    if (notified) {
      io.log('Notified the running cockpit — LAN listener closed.');
    } else {
      io.log('A cockpit that is already running keeps its LAN listener until it restarts —');
      io.log('restart it, or switch LAN access off in Settings → Security from this machine.');
    }
    return 0;
  }
  io.error(USAGE);
  return sub === 'help' || sub === '--help' ? 0 : 1;
}

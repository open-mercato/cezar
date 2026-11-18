import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { findDeviceCode, allowedVerificationUrl } from './process.ts';
import type { LoginChild, StartDriver } from './types.ts';

export const OPENCODE_READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 300;
const OAUTH_TTL_MS = 15 * 60_000;
/** Tried in order when the request names no auth provider; each has an allow-listed page. */
const OAUTH_PREFERENCE = ['openai', 'github-copilot', 'anthropic'] as const;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

type AuthMethods = Record<string, Array<{ type: string }>>;
interface Authorization { url?: unknown; method?: unknown; instructions?: unknown }

function parseAuthMethods(value: unknown): AuthMethods | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: AuthMethods = {};
  for (const [id, methods] of Object.entries(value as Record<string, unknown>)) {
    if (!PROVIDER_ID.test(id) || !Array.isArray(methods)) continue;
    out[id] = methods
      .map((m) => (m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string' ? { type: (m as { type: string }).type } : null))
      .filter((m): m is { type: string } => m !== null);
  }
  return out;
}

/**
 * OpenCode (spec checks table): its CLI login is an interactive prompt, so the sign-in goes through
 * a private `opencode serve` on a free loopback port — `GET /provider/auth`, then
 * `POST /provider/{id}/oauth/authorize` + `…/oauth/callback`, or `PUT /auth/{id}` for a key.
 * The server is killed when the session ends.
 */
export const startOpenCodeLogin: StartDriver = (ctl) => {
  let server: LoginChild | null = null;
  let disposed = false;
  let base = '';
  let keyProviders: string[] = [];
  let paste: { id: string; index: number } | null = null;
  let sent = false;
  const password = randomBytes(24).toString('hex');
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  const call = (path: string, method = 'GET', body?: unknown, timeoutMs?: number) => ctl.fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const finishCallback = async (id: string, index: number, code?: string) => {
    try {
      const response = await call(`/provider/${encodeURIComponent(id)}/oauth/callback`, 'POST', code === undefined ? { method: index } : { method: index, code }, OAUTH_TTL_MS);
      if (ctl.done()) return;
      const answer = response.ok ? await response.json().catch(() => null) : null;
      if (response.ok && answer !== false) ctl.succeed();
      else ctl.fail('rejected');
    } catch {
      if (!ctl.done()) ctl.fail('rejected');
    }
  };
  const offerKey = () => {
    if (keyProviders.length === 0) {
      ctl.fallbackToTerminal();
      return;
    }
    ctl.update({ method: 'key', phase: 'needs-input', keyProviders });
  };

  void (async () => {
    let port: number;
    try {
      port = await freeLoopbackPort();
    } catch {
      ctl.fail('unavailable');
      return;
    }
    if (disposed) return;
    base = `http://127.0.0.1:${port}`;
    try {
      server = ctl.spawn(ctl.executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        env: { ...ctl.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password },
      });
    } catch (error) {
      ctl.fail((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not-installed' : 'unavailable');
      return;
    }
    server.onExit((_code, error) => {
      if (!ctl.done()) ctl.fail(error === 'ENOENT' ? 'not-installed' : 'unavailable');
    });

    let methods: AuthMethods | null = null;
    const startedAt = ctl.now();
    while (!disposed && !ctl.done() && methods === null && ctl.now() - startedAt < OPENCODE_READY_TIMEOUT_MS) {
      try {
        const response = await call('/provider/auth');
        if (response.ok) methods = parseAuthMethods(await response.json());
      } catch {
        // not listening yet
      }
      if (methods === null) await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    if (disposed || ctl.done()) return;
    if (methods === null) {
      ctl.fallbackToTerminal();
      return;
    }
    keyProviders = Object.keys(methods).filter((id) => methods[id]!.some((m) => m.type === 'api')).sort();
    if (ctl.method === 'key') {
      offerKey();
      return;
    }
    const wanted = ctl.authProvider ? [ctl.authProvider] : OAUTH_PREFERENCE;
    const id = wanted.find((candidate) => methods[candidate]?.some((m) => m.type === 'oauth'));
    if (!id) {
      offerKey();
      return;
    }
    const index = methods[id]!.findIndex((m) => m.type === 'oauth');
    const authorize = await call(`/provider/${encodeURIComponent(id)}/oauth/authorize`, 'POST', { method: index })
      .then(async (response) => (response.ok ? ((await response.json()) as Authorization | null) : null))
      .catch(() => null);
    if (disposed || ctl.done()) return;
    const url = typeof authorize?.url === 'string' ? allowedVerificationUrl(`opencode:${id}`, authorize.url) : undefined;
    if (!authorize || !url) {
      offerKey();
      return;
    }
    const expiresAt = new Date(ctl.now() + OAUTH_TTL_MS).toISOString();
    if (authorize.method === 'code') {
      paste = { id, index };
      ctl.update({ method: 'paste', phase: 'needs-input', url, expiresAt });
      return;
    }
    const userCode = typeof authorize.instructions === 'string' ? findDeviceCode(authorize.instructions) : undefined;
    // A localhost-callback page cannot finish on another device.
    if (!userCode && ctl.remote) {
      offerKey();
      return;
    }
    ctl.update(userCode
      ? { method: 'device', phase: 'waiting', url, userCode, expiresAt }
      : { method: 'browser', phase: 'waiting', url, expiresAt });
    void finishCallback(id, index);
  })();

  return {
    input: async (body) => {
      if ('code' in body) {
        if (!paste || sent) return { ok: false, status: 409, error: 'This sign-in is not waiting for a code.' };
        sent = true;
        ctl.update({ phase: 'verifying' });
        void finishCallback(paste.id, paste.index, body.code.trim());
        return { ok: true };
      }
      if (keyProviders.length === 0 || paste) return { ok: false, status: 409, error: 'This sign-in is not waiting for a key.' };
      const target = body.keyProvider ?? (keyProviders.length === 1 ? keyProviders[0] : undefined);
      if (!target || !keyProviders.includes(target)) {
        return { ok: false, status: 400, error: `keyProvider must be one of ${keyProviders.join(', ')}` };
      }
      if (sent) return { ok: false, status: 409, error: 'The key was already sent.' };
      sent = true;
      ctl.update({ phase: 'verifying' });
      try {
        const response = await call(`/auth/${encodeURIComponent(target)}`, 'PUT', { type: 'api', key: body.apiKey.trim() });
        if (!ctl.done()) {
          if (response.ok) ctl.succeed();
          else ctl.fail('rejected');
        }
      } catch {
        if (!ctl.done()) ctl.fail('rejected');
      }
      return { ok: true };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      server?.kill();
    },
  };
};

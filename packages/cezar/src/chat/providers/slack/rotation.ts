import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { SlackCredentials } from '@open-mercato/cezar-contract';
import { slackAppTokenPattern, slackBotTokenPattern, slackRefreshTokenPattern } from '@open-mercato/cezar-contract';
import { SecretStore, type SecretScopeRef } from '../../../workspace/secrets.ts';
import { cezarHomeDir } from '../../../paths.ts';
import { withLifecycleFileLock } from '../../../worktree-lifecycle/store.ts';
import { ChatTransportError } from '../../provider.ts';

const stateSchema = z.discriminatedUnion('phase', [
 z.strictObject({ phase: z.literal('pending') }),
 z.strictObject({ phase: z.literal('ready'), access: z.string(), refresh: z.string().regex(slackRefreshTokenPattern), expiresAt: z.number().finite().positive() }),
]);
type State = z.infer<typeof stateSchema>;
export interface SlackRotationStorage {
 read(key: string): Promise<string | undefined>;
 write(key: string, value: string): Promise<void>;
 lock<T>(key: string, action: () => Promise<T>): Promise<T>;
}
/** Tokens stay in the project vault; the non-secret lock coordinates every wire using that vault. */
export function slackRotationStorage(scope: Extract<SecretScopeRef, { kind: 'project' }>, store = new SecretStore(), home = cezarHomeDir()): SlackRotationStorage {
 return {
  async read(key) {
   const result = await store.read(scope);
   if (result.skipped) throw new Error('Vault unavailable');
   const entry = result.values[key];
   if (entry && (entry.audiences.length !== 1 || entry.audiences[0] !== 'cezar')) throw new Error('Invalid audience');
   return entry?.value;
  },
  async write(key, value) { await store.set(scope, key, value, ['cezar']); },
  lock: (key, action) => withLifecycleFileLock(join(home, 'slack-token-locks', key), action),
 };
}
const PRE_CONNECT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT']);
/** Connection-phase failures carry their code on `cause`; anything else may have reached Slack. */
export function neverSent(error: unknown): boolean {
 const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
 return typeof code === 'string' && PRE_CONNECT.has(code);
}
const failure = (kind: 'auth' | 'transient' | 'blocked') => new ChatTransportError({ kind });
export class SlackTokenRotation {
 constructor(private readonly storage: SlackRotationStorage, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}
 async token(credentials: SlackCredentials, kind: 'app' | 'bot', signal?: AbortSignal, valid = () => true): Promise<string> {
  const initial = credentials[`${kind}Token`];
  if (!initial.startsWith('xoxe.')) return initial;
  const refresh = credentials[`${kind}RefreshToken`], { clientId, clientSecret } = credentials;
  if (!refresh || !clientId || !clientSecret) throw failure('auth');
  const key = `SLACK_ROTATION_${createHash('sha256').update(JSON.stringify([kind, refresh, clientId, clientSecret])).digest('hex').toUpperCase()}`;
  const guard = () => { if (signal?.aborted || !valid()) throw failure('blocked'); };
  try {
   return await this.storage.lock(key, async () => {
    guard();
    const raw = await this.storage.read(key);
    const stored = raw === undefined ? undefined : stateSchema.parse(JSON.parse(raw));
    if (stored?.phase === 'pending') throw failure('auth');
    const pattern = kind === 'app' ? slackAppTokenPattern : slackBotTokenPattern;
    if (stored && !pattern.test(stored.access)) throw failure('auth');
    if (stored && stored.expiresAt > this.now() + 5 * 60_000) { guard(); return stored.access; }
    // Record uncertainty BEFORE sending a single-use refresh token; never replay it after a crash.
    await this.storage.write(key, JSON.stringify({ phase: 'pending' }));
    try { guard(); } catch (error) {
     // Cancellation before fetch cannot have consumed the refresh token.
     await this.storage.write(key, JSON.stringify(stored ?? { phase: 'ready', access: initial, refresh, expiresAt: 1 } satisfies State));
     throw error;
    }
    let response: Response;
    try {
     response = await this.fetcher('https://slack.com/api/oauth.v2.access', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: stored?.refresh ?? refresh }).toString(),
     });
    } catch (error) {
     // The request never left this machine (offline laptop, DNS, refused): the token is unspent.
     if (!neverSent(error)) throw failure('auth');
     await this.storage.write(key, JSON.stringify(stored ?? { phase: 'ready', access: initial, refresh, expiresAt: 1 } satisfies State));
     throw failure('transient');
    }
    if (response.status === 429) {
     // A rate-limit rejection did not exchange the token. Keep it for a bounded retry.
     const previous: State = stored ?? { phase: 'ready', access: initial, refresh, expiresAt: 1 };
     await this.storage.write(key, JSON.stringify(previous));
     const seconds = Number(response.headers.get('retry-after'));
     throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 5000 });
    }
    if (!response.ok) throw failure('auth');
    const reader = response.body?.getReader();
    if (!reader) throw failure('auth');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
     for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 32 * 1024) { await reader.cancel(); throw failure('auth'); }
      chunks.push(value);
     }
    } finally { reader.releaseLock(); }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (z.object({ ok: z.literal(false) }).safeParse(payload).success) throw failure('auth');
    const result = z.object({ ok: z.literal(true), token_type: z.literal(kind === 'app' ? 'app_level' : 'bot'), access_token: z.string().regex(pattern), refresh_token: z.string().regex(slackRefreshTokenPattern), expires_in: z.number().int().min(600).max(86400) }).parse(payload);
    // Finish saving even if the caller cancelled: Slack has already consumed the old token.
    await this.storage.write(key, JSON.stringify({ phase: 'ready', access: result.access_token, refresh: result.refresh_token, expiresAt: this.now() + result.expires_in * 1000 } satisfies State));
    guard(); return result.access_token;
   });
  } catch (error) { if (error instanceof ChatTransportError) throw error; throw failure('transient'); }
 }
}

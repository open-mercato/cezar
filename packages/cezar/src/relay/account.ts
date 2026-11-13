import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relayAccountStatusSchema, type RelayAccountStatus } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import type { RelayIdentity } from './identity.ts';
import { b64u, postProof, proofHeaders } from './wire.ts';

/**
 * The relay account (RELAY_PROTOCOL.md § 18): who runs this cezar accepted the terms and named an
 * email. The token is sealed with a key derived from the relay identity, which lives in the OS
 * keychain, so `account.json` alone reveals the email and nothing that works.
 */

const ACCOUNT_TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 8_192;

export const ACCOUNT_PATHS = {
  start: '/v1/accounts',
  status: '/v1/accounts/status',
  resend: '/v1/accounts/resend',
  devices: '/v1/accounts/devices',
  delete: '/v1/accounts/delete',
} as const;

/** The header that carries the token on `GET /v1/cezar/{cezarId}`. */
export const ACCOUNT_HEADER = 'X-Cezar-Relay-Account';

const fileSchema = z.looseObject({
  /** The relay the token came from: another relay never saw it. */
  origin: z.string().max(300).optional().catch(undefined),
  cezarId: z.string().max(64).optional().catch(undefined),
  email: z.string().max(254).optional().catch(undefined),
  termsVersion: z.string().max(32).optional().catch(undefined),
  /** `iv ‖ ciphertext ‖ tag`, base64url, AES-256-GCM under `sealKey`. */
  sealed: z.string().max(1024).optional().catch(undefined),
  /** The one-time prompt for phones paired before accounts existed was shown. */
  prompted: z.boolean().optional().catch(undefined),
});
type AccountFile = z.infer<typeof fileSchema>;

export class RelayAccountFile {
  private readonly path: string;
  private state: AccountFile | undefined;

  constructor(directory: string) {
    this.path = join(directory, 'account.json');
  }

  read(): AccountFile {
    if (this.state) return this.state;
    let parsed: AccountFile = {};
    try {
      const result = fileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (result.success) parsed = result.data;
    } catch {
      // Missing or corrupt: no account. The user is asked again, and the relay keeps the truth.
    }
    this.state = parsed;
    return parsed;
  }

  write(patch: Partial<AccountFile>): void {
    const next: AccountFile = { ...this.read(), ...patch };
    for (const key of Object.keys(next) as (keyof AccountFile)[]) if (next[key] === undefined) delete next[key];
    atomicWriteJsonSync(this.path, { version: 1, ...next });
    this.state = next;
  }

  /** The token, if one was saved for this relay and these keys. A file from other keys is ignored. */
  token(identity: RelayIdentity, origin: string): string | undefined {
    const state = this.read();
    if (!state.sealed || state.origin !== origin || state.cezarId !== identity.cezarId) return undefined;
    return unseal(identity.sealKey, state.sealed) ?? undefined;
  }

  saveToken(identity: RelayIdentity, origin: string, token: string, email: string, termsVersion: string): void {
    this.write({ origin, cezarId: identity.cezarId, email, termsVersion, sealed: seal(identity.sealKey, token), prompted: true });
  }

  /** `bad-token`, or another relay: what was attached here no longer is. The email stays as a hint. */
  dropToken(): void {
    this.write({ sealed: undefined, origin: undefined, cezarId: undefined });
  }
}

export function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return b64u(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

export function unseal(key: Buffer, sealed: string): string | null {
  try {
    const bytes = Buffer.from(sealed, 'base64url');
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---- the endpoints -------------------------------------------------------------------------------

export type AccountPost = (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number; json: unknown; retryAfter?: number }>;

const defaultPost: AccountPost = async (url, { headers, body }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
  });
  const text = (await response.text()).slice(0, MAX_ANSWER_BYTES);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not ours: the status alone decides.
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  return { status: response.status, json, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
};

/** A refused account call. `code` is the relay's, or `unreachable` when nothing answered. */
export class RelayAccountCallError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number, readonly current?: string) {
    super(code);
  }
}

const startAnswer = z.object({
  account: z.string(),
  token: z.string().min(1).max(256),
  status: relayAccountStatusSchema,
  codeSent: z.boolean(),
  retryAfter: z.number().optional(),
});
const statusAnswer = z.object({ account: z.string().nullable(), status: relayAccountStatusSchema });
const resendAnswer = z.object({ expiresAt: z.number() });

export class RelayAccountClient {
  private readonly post: AccountPost;

  constructor(post?: AccountPost, private readonly now: () => number = Date.now) {
    this.post = post ?? defaultPost;
  }

  private async call(origin: string, path: string, payload: unknown, identity: RelayIdentity | null): Promise<{ status: number; json: unknown }> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const time = Math.floor(this.now() / 1000);
    const headers = identity ? { ...proofHeaders(identity.edSeed, postProof(path, body, time), time) } : {};
    let answer: Awaited<ReturnType<AccountPost>>;
    try {
      answer = await this.post(`${origin}${path}`, { headers, body });
    } catch {
      throw new RelayAccountCallError(0, 'unreachable');
    }
    if (answer.status >= 200 && answer.status < 300) return answer;
    const refusal = (answer.json && typeof answer.json === 'object' ? answer.json : {}) as { code?: unknown; current?: unknown };
    const code = typeof refusal.code === 'string' ? refusal.code : answer.status >= 500 ? 'unavailable' : String(answer.status);
    throw new RelayAccountCallError(answer.status, code, answer.retryAfter, typeof refusal.current === 'string' ? refusal.current : undefined);
  }

  private parse<T>(schema: z.ZodType<T>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new RelayAccountCallError(502, 'bad-answer');
    return parsed.data;
  }

  async start(origin: string, identity: RelayIdentity, email: string, termsVersion: string): Promise<z.infer<typeof startAnswer>> {
    const { json } = await this.call(origin, ACCOUNT_PATHS.start, { email, termsVersion, accepted: true }, identity);
    return this.parse(startAnswer, json);
  }

  async status(origin: string, identity: RelayIdentity): Promise<{ account: string | null; status: RelayAccountStatus }> {
    const { json } = await this.call(origin, ACCOUNT_PATHS.status, {}, identity);
    return this.parse(statusAnswer, json);
  }

  async resend(origin: string, identity: RelayIdentity, token: string): Promise<{ expiresAt: number }> {
    const { json } = await this.call(origin, ACCOUNT_PATHS.resend, { token }, identity);
    return this.parse(resendAnswer, json);
  }

  async devices(origin: string, identity: RelayIdentity, token: string, devices: string[]): Promise<void> {
    await this.call(origin, ACCOUNT_PATHS.devices, { token, devices }, identity);
  }

  async delete(origin: string, identity: RelayIdentity, token: string): Promise<void> {
    await this.call(origin, ACCOUNT_PATHS.delete, { token }, identity);
  }
}

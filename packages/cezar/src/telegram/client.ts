import type { Agent } from 'undici';
import { telegramBotTokenSchema } from '@open-mercato/cezar-contract';
import { DestinationPolicyError, validateDestination, type DestinationPolicy, type Lookup } from '../webhooks/destination.ts';

export type TelegramMethod = 'getMe' | 'getChat' | 'getChatMember' | 'getUpdates' | 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup' | 'setMyCommands';
export class TelegramApiError extends Error {
  constructor(readonly code: 'network' | 'policy' | 'dns_not_found' | 'body_limit' | 'invalid_response' | 'http', readonly status?: number, readonly retryAfter?: number) {
    super(`Telegram request failed: ${code}`);
  }
}
export type TelegramCall = (method: TelegramMethod, body: object, signal?: AbortSignal, authorization?: { valid?: () => boolean }) => Promise<unknown>;
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new TelegramApiError('network'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// One pooled Agent per pinned address: a TLS handshake per call doubled every reply's latency.
const agents = new Map<string, Agent>();
async function agentFor(address: string, family: number): Promise<Agent> {
  const key = `${family}/${address}`, existing = agents.get(key);
  if (existing) return existing;
  const { Agent } = await import('undici');
  // Long poll plus concurrent replies; the lookup stays pinned to the validated address.
  const agent = new Agent({ connections: 4, pipelining: 1, connect: { rejectUnauthorized: true, autoSelectFamily: false,
    lookup(_hostname, lookupOptions, callback) {
      if (lookupOptions.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    } } });
  agents.set(key, agent);
  for (const [stale, old] of agents) if (agents.size > 4 && stale !== key) { agents.delete(stale); void old.close().catch(() => undefined); }
  return agent;
}

/** Fixed Telegram methods/host, pinned public DNS, deadline includes lookup and body. Never logs the URL. */
export function telegramClient(options: {
  token(): Promise<string>; policy: DestinationPolicy; lookup?: Lookup; dryRun?: boolean;
}): TelegramCall {
  return async (method, body, parentSignal, authorization) => {
    // Dry-run requires an injected simulated transport; no accidental live call is possible.
    if (options.dryRun) throw new TelegramApiError('policy');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort', abort, { once: true });
    const deadline = method === 'getUpdates' ? 35_000 : 10_000;
    const timer = setTimeout(abort, deadline);
    try {
      const token = telegramBotTokenSchema.parse(await bounded(options.token(), controller.signal));
      const target = await bounded(validateDestination(`https://api.telegram.org/bot${token}/${method}`, { ...options.policy, allowLocalNetwork: false }, options.lookup), controller.signal);
      const { request } = await import('undici');
      const dispatcher = await agentFor(target.address, target.family);
      // Preparation can outlive a reply grant; recheck once asynchronous preparation completes.
      if (authorization?.valid && !authorization.valid()) throw new TelegramApiError('policy');
      const response = await request(target.url, { dispatcher, method: 'POST', body: JSON.stringify(body), signal: controller.signal,
        maxRedirections: 0, headersTimeout: deadline, bodyTimeout: deadline, headers: { 'content-type': 'application/json', 'user-agent': 'cezar-telegram/1' } });
      const chunks: Buffer[] = []; let length = 0;
      try {
        await bounded((async () => {
          for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 1024 * 1024) throw new TelegramApiError('body_limit');
            chunks.push(Buffer.from(chunk));
          }
        })(), controller.signal);
      } finally { response.body.destroy(); }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        if (response.statusCode !== 200) throw new TelegramApiError('http', response.statusCode);
        throw new TelegramApiError('invalid_response');
      }
      if (!data || typeof data !== 'object') {
        if (response.statusCode !== 200) throw new TelegramApiError('http', response.statusCode);
        throw new TelegramApiError('invalid_response');
      }
      const envelope = data as Record<string, unknown>;
      if (response.statusCode !== 200 || envelope.ok !== true) {
        const parameters = envelope.parameters as { retry_after?: unknown } | undefined;
        const wait = parameters?.retry_after;
        throw new TelegramApiError('http', response.statusCode,
          typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0 ? wait : undefined);
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (error instanceof DestinationPolicyError) throw new TelegramApiError(error.code === 'dns_not_found' ? 'dns_not_found' : 'policy');
      throw new TelegramApiError('network');
    } finally {
      clearTimeout(timer); parentSignal?.removeEventListener('abort', abort);
    }
  };
}

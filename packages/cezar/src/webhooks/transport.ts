import type { WebhookFormat } from '@open-mercato/cezar-contract';
import type { Agent } from 'undici';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { DestinationPolicyError, validateDestination, type DestinationPolicy, type Lookup } from './destination.ts';
import { signWebhook } from './signing.ts';

export interface WebhookSend {
  format?: WebhookFormat; url: string; body: string; eventId: string; secrets: readonly string[]; policy: DestinationPolicy;
  /** Redaction only; never passed to HMAC signing. */
  diagnosticSecrets?: readonly string[];
  signal?: AbortSignal;
}
export type SendResult = { kind: 'http'; status: number; providerCode?: 10015 | 50027; contentType?: string; response?: string; retryAfter?: string }
  | { kind: 'policy' | 'transient'; reason: string };
type HttpResult = Extract<SendResult, { kind: 'http' }>;
const discordHosts = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
// RFC 9110 §5.6.7: IMF-fixdate, RFC850 and asctime only. Date.parse
// alone accepts comments, arbitrary suffixes and non-HTTP date formats.
const weekday = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const month = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const clock = '([0-9]{2}):([0-9]{2}):([0-9]{2})';
const imfDate = new RegExp('^' + weekday + ', ([0-9]{2}) ' + month + ' ([0-9]{4}) ' + clock + ' GMT$');
const obsoleteDate = new RegExp('^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-' + month + '-([0-9]{2}) ' + clock + ' GMT$');
const asctimeDate = new RegExp('^' + weekday + ' ' + month + ' ([0-9]{2}| [0-9]) ' + clock + ' ([0-9]{4})$');
function validatedRetryAfter(raw: string | undefined, now = Date.now()): { value: string; seconds?: number; date?: number } | undefined {
  if (raw === undefined || Buffer.byteLength(raw) >= 16384 || /[\r\n]/.test(raw)) return undefined;
  // Only HTTP optional whitespace, never remove an invalid suffix or clip.
  const value = raw.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return { value, seconds: Number(value) };
  const obsolete = obsoleteDate.exec(value);
  const match = imfDate.exec(value) ?? obsolete;
  const asc = match ? null : asctimeDate.exec(value);
  if (!match && !asc) return undefined;
  const [day, monthName, yearText, hour, minute, second] = match
    ? match.slice(1) : [asc![2], asc![1], asc![6], asc![3], asc![4], asc![5]];
  let year = Number(yearText);
  const future = new Date(now);
  future.setUTCFullYear(future.getUTCFullYear() + 50);
  if (obsolete) year += Math.floor(future.getUTCFullYear() / 100) * 100;
  const monthIndex = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(monthName!) / 3;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Math.min(59, Number(second)), 0);
  if (obsolete && date.getTime() > future.getTime()) {
    year -= 100;
    date.setUTCFullYear(year, monthIndex, Number(day));
  }
  // Reject calendar normalization (e.g. February 31); allow HTTP leap seconds.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== Number(day)) return undefined;
  return { value, date: date.getTime() + (Number(second) === 60 ? 1000 : 0) };
}
// Original complete, bounded diagnostics live only for the result's lifetime,
// outside its serializable surface. A later receiver may contain an earlier
// masked value, so persistence must redact the original text, never a prefix or
// an already-redacted string. Neither raw text nor this context goes to disk.
const diagnosticContexts = new WeakMap<SendResult, { raw: HttpResult; secrets: readonly string[] }>();
export function redactWebhookDiagnostics(result: SendResult, secrets: readonly string[], omitText = false): SendResult {
  if (result.kind !== 'http') return result;
  const context = diagnosticContexts.get(result);
  const raw = context?.raw ?? result;
  // Protocol timing is not display text: redaction or clipping can turn a
  // valid delay into an earlier retry. Share the bounded grammar on every path.
  const timing = validatedRetryAfter(raw.retryAfter)?.value;
  const provider = raw.providerCode === 10015 || raw.providerCode === 50027 ? { providerCode: raw.providerCode } : {};
  if (omitText) {
    // Only validated timing survives incomplete secret coverage.
    return { kind: 'http', status: raw.status, ...provider, ...(timing ? { retryAfter: timing } : {}) };
  }
  const values = [...(context?.secrets ?? []), ...collectSecretValues(), ...secrets];
  const clean = (value: string | undefined, limit: number, inputLimit: number) => value !== undefined && Buffer.byteLength(value) <= inputLimit
    ? redactSecrets(value, values).slice(0, limit) : undefined;
  const response = clean(raw.response, 4096, 4096), contentType = clean(raw.contentType, 256, 16384), retryAfter = timing;
  return { kind: 'http', status: raw.status, ...provider, ...(response !== undefined ? { response } : {}),
    ...(contentType ? { contentType } : {}), ...(retryAfter ? { retryAfter } : {}) };
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function sendWebhook(input: WebhookSend, dependencies: { lookup?: Lookup; now?: () => number } = {}): Promise<SendResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  let dispatcher: Agent | undefined;
  try {
    const target = await untilAbort(validateDestination(input.url, input.policy, dependencies.lookup), controller.signal);
    // Discord's default wait=false can acknowledge a message it did not save.
    // Only the native adapter adds this protocol option; saved/user URLs stay unchanged.
    if (input.format === 'discord.v1' && target.url.protocol === 'https:' && discordHosts.has(target.url.hostname)) {
      target.url.searchParams.set('wait', 'true');
    }
    // Load the HTTP client only for an actual send, after destination validation.
    const { Agent, request } = await untilAbort(import('undici'), controller.signal);
    dispatcher = new Agent({
      connections: 1, pipelining: 1,
      connect: {
        rejectUnauthorized: true, autoSelectFamily: false,
        lookup(_hostname, options, callback) {
          // DNS was validated as an entire set; the connector gets one pinned answer only.
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
    });
    const timestamp = Math.floor((dependencies.now ?? Date.now)() / 1000);
    const result = await request(target.url, {
      dispatcher, method: 'POST', body: input.body, signal: controller.signal,
      maxRedirections: 0, headersTimeout: 10_000, bodyTimeout: 10_000,
      headers: {
        'content-type': 'application/json', 'user-agent': 'cezar-webhooks/1',
        ...(input.format === undefined || input.format === 'cezar.json.v1' ? {
          'webhook-id': input.eventId, 'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(input.eventId, timestamp, input.body, input.secrets),
        } : {}),
      },
    });
    const secretValues = [...collectSecretValues(), ...input.secrets, input.url, ...(input.diagnosticSecrets ?? [])];
    // Undici's total header limit is 16 KiB. Keep complete values up to that
    // bound for the final redaction pass. Only diagnostic text gets a display cap.
    const header = (name: string) => {
      const value = result.headers[name]; return typeof value === 'string' && Buffer.byteLength(value) < 16384 ? value : undefined;
    };
    const contentType = header('content-type'), retryAfter = header('retry-after');
    let response: string | undefined;
    // Path/query values may be credentials of any length. A proxy can echo
    // arbitrary decoded fragments, which value redaction cannot reliably cover.
    // Keep status/retry diagnostics, but never retain that untrusted body.
    const destination = new URL(input.url);
    const chat = !target.private && !destination.search && destination.protocol === 'https:'
      ? input.format === 'slack.v1' && destination.hostname === 'hooks.slack.com' ? 'slack'
        : input.format === 'discord.v1' && discordHosts.has(destination.hostname) ? 'discord' : undefined
      : undefined;
    if ((!chat && (target.private || destination.pathname !== '/' || destination.search))
      || (chat === 'discord' && result.statusCode >= 200 && result.statusCode < 300)) {
      // An unread undici body has no iterator error handler. destroy() emits
      // UND_ERR_ABORTED asynchronously, outside this function's try/catch.
      // Consume that disposal error without draining an unbounded response.
      result.body.once('error', () => undefined);
      result.body.destroy();
    }
    else {
      const chunks: Buffer[] = []; let remaining = chat === 'slack' ? 65 : chat === 'discord' ? 513 : 4096;
      let complete = true;
      try {
        for await (const chunk of result.body) {
          const bytes = Buffer.from(chunk);
          // Never redact a clipped prefix: it may end inside a known secret.
          // At the limit, cancel immediately rather than waiting for EOF or
          // draining an unbounded stream just to decide if it was complete.
          if (bytes.length >= remaining) {
            complete = false;
            result.body.destroy();
            break;
          }
          chunks.push(bytes); remaining -= bytes.length;
        }
        if (complete) response = Buffer.concat(chunks).toString('utf8');
      } catch {
        // A partial response does not negate the HTTP status already received.
        response = undefined;
      }
    }
    const diagnostics = chatDiagnostics(chat, response);
    if (chat) response = diagnostics.response;
    const raw: HttpResult = { kind: 'http', status: result.statusCode, ...diagnostics.protocol, ...(contentType ? { contentType } : {}), ...(retryAfter ? { retryAfter } : {}), ...(response !== undefined ? { response } : {}) };
    const sanitized = redactWebhookDiagnostics(raw, secretValues);
    diagnosticContexts.set(sanitized, { raw, secrets: secretValues });
    return sanitized;
  } catch (error) {
    if (error instanceof DestinationPolicyError) return { kind: 'policy', reason: error.code };
    return { kind: 'transient', reason: controller.signal.aborted ? 'timeout' : 'connection_failed' };
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
  }
}
export function retryAt(attempt: number, now: number, retryAfter?: string, random: () => number = Math.random): number {
  const base = Math.min(3_600_000, 5000 * 2 ** Math.min(Math.max(0, attempt - 1), 20));
  const backoff = Math.min(3_600_000, base * (1 + Math.max(0, Math.min(1, random())) * 0.2));
  let requested = 0;
  // Saturate valid oversized delays instead of falling back to an early retry.
  // The caller compares this deadline with delivery expiry before scheduling.
  const maxDate = 8_640_000_000_000_000;
  const timing = validatedRetryAfter(retryAfter, now);
  if (timing?.seconds !== undefined) requested = Math.min(maxDate, now + timing.seconds * 1000);
  else if (timing?.date !== undefined) requested = timing.date;
  return Math.min(maxDate, Math.max(now + backoff, Number.isFinite(requested) ? requested : 0));
}

// Provider diagnostics are a closed vocabulary, never arbitrary path/token echoes.
function chatDiagnostics(provider: 'slack' | 'discord' | undefined, body: string | undefined): {
  response?: string; protocol?: { providerCode: 10015 | 50027 };
} {
  if (!provider || body === undefined) return {};
  if (provider === 'slack') {
    const codes = new Set(['ok', 'invalid_token', 'no_service', 'channel_not_found', 'channel_is_archived',
      'invalid_payload', 'action_prohibited', 'no_active_hooks', 'no_service_id', 'no_team',
      'posting_to_general_channel_denied', 'team_disabled', 'too_many_attachments', 'user_not_found', 'rollup_error']);
    return codes.has(body) ? { response: body } : {};
  }
  try {
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== 'object') return {};
    const { code, message } = data as { code?: unknown; message?: unknown };
    const knownMessage = typeof message === 'string' && ['Unknown Webhook', 'Invalid Webhook Token', 'Invalid Form Body', 'You are being rate limited.'].includes(message);
    const integerCode = typeof code === 'number' && Number.isSafeInteger(code);
    return {
      ...(integerCode || knownMessage ? { response: JSON.stringify({ ...(integerCode ? { code } : {}), ...(knownMessage ? { message } : {}) }) } : {}),
      ...(code === 10015 || code === 50027 ? { protocol: { providerCode: code } } : {}),
    };
  } catch { return {}; }
}

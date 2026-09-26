import type { TrackerFailure, TrackerNotFound, TrackerInvalidCursor } from '@open-mercato/cezar-contract';

export class TrackerRequestError extends Error {
  constructor(
    readonly code: TrackerFailure['code'] | 'not_found' | 'invalid_cursor',
    readonly reason: string,
    readonly retryAfterSeconds?: number,
  ) { super(reason); }
}

/** The same deadline covers discovery, fallback, fetch and streaming the response. */
export async function runOperation<T>(read: (signal: AbortSignal) => Promise<T>, timeout = 10_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TrackerRequestError('unavailable', 'Tracker request timed out. Try again.'));
    }, timeout);
  });
  try { return await Promise.race([read(controller.signal), deadline]); }
  finally { clearTimeout(timer!); }
}

export function requestFailure(error: unknown): TrackerFailure | TrackerNotFound | TrackerInvalidCursor {
  if (error instanceof TrackerRequestError && error.code === 'not_found') return { available: false, code: 'not_found', reason: error.reason };
  if (error instanceof TrackerRequestError && error.code === 'invalid_cursor') return { available: false, code: 'invalid_cursor', reason: error.reason };
  if (error instanceof TrackerRequestError) return {
    available: false, code: error.code, reason: error.reason,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  };
  return { available: false, code: 'unavailable', reason: 'Tracker is unavailable. Check connectivity and try again.' };
}

/** Never retain/log HTTP bodies or request headers in errors. */
export class TrackerHttp {
  private cooldownUntil = 0;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  rateLimit(seconds = 60): never {
    const bounded = Number.isFinite(seconds) ? Math.max(1, Math.min(86_400, Math.ceil(seconds))) : 60;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + bounded * 1000);
    throw new TrackerRequestError('rate_limited', 'Tracker rate limit reached. Retry after the cooldown.', bounded);
  }

  async json(url: string, init: RequestInit, signal: AbortSignal, inspectHeaders?: (headers: Headers, status: number) => number | undefined): Promise<unknown> {
    if (this.cooldownUntil > Date.now()) throw new TrackerRequestError('rate_limited', 'Tracker rate limit reached. Retry after the cooldown.', Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    const response = await this.fetcher(url, { ...init, signal, redirect: 'error' });
    const rateLimitHint = inspectHeaders?.(response.headers, response.status);
    if (response.status === 429) {
      const hint = response.headers.get('retry-after');
      await response.body?.cancel();
      this.rateLimit(hint ? (/^\d+$/.test(hint) ? Number(hint) : (Date.parse(hint) - Date.now()) / 1000) : rateLimitHint ?? 60);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new TrackerRequestError('unauthorized', 'Tracker denied access. Check credentials and read permissions.');
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new TrackerRequestError('not_found', 'The requested tracker item was not found in this scope.');
    }
    // GraphQL reports rate limits with HTTP 400; its adapter interprets the bounded JSON body.
    if (!response.ok && response.status !== 400) {
      await response.body?.cancel();
      throw new TrackerRequestError('unavailable', 'Tracker request failed. Try again later.');
    }
    const cap = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length') ?? 0) > cap) {
      await response.body?.cancel();
      throw new TrackerRequestError('invalid_response', 'Tracker response exceeded the size limit. Narrow the request.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TrackerRequestError('invalid_response', 'Tracker returned an empty response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > cap) throw new TrackerRequestError('invalid_response', 'Tracker response exceeded the size limit. Narrow the request.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new TrackerRequestError('invalid_response', 'Tracker returned invalid JSON.'); }
  }
}

/** Per-provider instances isolate credentials; callers include scope and query in the key. */
export class ResultCache<T extends { available: boolean }> {
  private entries = new Map<string, { value: T; at: number }>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;
  constructor(private readonly maximum = 200, private readonly ttl = 60_000, private readonly now = Date.now) {}
  clear(): void { this.generation++; this.entries.clear(); this.pending.clear(); }
  async get(key: string, read: () => Promise<T>, refresh = false): Promise<T> {
    const cached = this.entries.get(key);
    if (!refresh && cached && this.now() - cached.at < this.ttl) {
      this.entries.delete(key); this.entries.set(key, cached); return cached.value;
    }
    this.entries.delete(key);
    const current = this.pending.get(key);
    if (current) return current;
    const generation = this.generation;
    // Start immediately so cancellation/invalidation can never precede the operation's setup.
    const promise = read().then(value => {
      if (value.available && generation === this.generation) {
        this.entries.set(key, { value, at: this.now() });
        while (this.entries.size > this.maximum) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
}

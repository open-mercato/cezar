import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * A JSON request whose ONLY deadline is the one the caller passes.
 *
 * Why this exists instead of `fetch` (2026-07-25, live run): a council reviewer
 * was cut off at exactly 5:01 — twice — and cezar could only report
 * `fetch failed`. Node's global fetch is undici, whose `headersTimeout`
 * defaults to 300_000 ms. `POST /session/:id/message` on an opencode server
 * sends no response headers until the model has finished, so any turn longer
 * than five minutes was aborted as `TypeError: fetch failed`
 * (`UND_ERR_HEADERS_TIMEOUT`) — silently overriding cezar's own 30-minute run
 * timeout and capping every long opencode turn at five minutes.
 *
 * undici is not a dependency of this package (it only appears transitively
 * under jsdom), so a `dispatcher` override is not available to us. `node:http`
 * is: it applies no header/body deadline of its own, which makes the caller's
 * `timeoutMs` the single source of truth — and lets the failure say so.
 */
export interface JsonRequestOptions {
  method: string;
  /** Serialized as JSON with `content-type: application/json`. Omit for GET. */
  body?: unknown;
  /** The one and only deadline, measured from request start to response end.
   *  Non-positive means no deadline (the runner's `limitMs: 0`). */
  timeoutMs: number;
  /** Aborts the in-flight request (run cancellation). */
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface JsonResponse {
  ok: boolean;
  status: number;
  /** Raw body; callers parse. Non-2xx is returned, not thrown. */
  text: string;
}

/**
 * Open a streaming GET (Server-Sent Events) and resolve once the response
 * headers arrive; the caller drains the body.
 *
 * Deliberately deadline-free. An SSE stream is *expected* to sit idle between
 * events, which is precisely what undici's 300s `bodyTimeout` treats as a
 * failure — so on a long quiet turn the global-`fetch` version dropped the
 * event stream and the cockpit went silent while work carried on. Lifetime is
 * owned by the caller's `signal`.
 */
export function streamRequest(
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<IncomingMessage> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: opts.headers ?? {},
      },
      (res) => resolve(res),
    );
    req.on('error', reject);
    const onAbort = () => req.destroy();
    if (opts.signal) {
      if (opts.signal.aborted) return req.destroy(), reject(new Error('aborted'));
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export function jsonRequest(url: string, opts: JsonRequestOptions): Promise<JsonResponse> {
  const { method, body, timeoutMs, signal, headers = {} } = opts;
  const target = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise<JsonResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          finish(() =>
            resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, text }),
          ),
        );
        res.on('error', (err) => finish(() => reject(err)));
      },
    );

    // The deadline covers headers AND body — a stalled response is a failure
    // even if the status line arrived.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            req.destroy();
            finish(() =>
              reject(
                new Error(
                  `${method} ${target.pathname} timed out after ${timeoutMs}ms (no response from ${target.host})`,
                ),
              ),
            );
          }, timeoutMs)
        : undefined;
    timer?.unref?.();

    const onAbort = () => {
      req.destroy();
      finish(() => reject(new Error(`${method} ${target.pathname} aborted`)));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => finish(() => reject(err)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

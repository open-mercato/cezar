import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';

/**
 * The runner's door to a local `opencode serve`: one JSON request, and the SSE
 * subscription. Neither carries a client-side header or body timeout.
 *
 * Why not the global `fetch`. Node's `fetch` is undici, and undici applies a
 * `headersTimeout`/`bodyTimeout` default of 300_000 ms to every request. The
 * prompt POST is a long poll — opencode does not answer `POST
 * /session/:id/message` until the agent's turn is over, tools and all — so at
 * exactly 5:00 undici tore it down with `TypeError: fetch failed`, the runner
 * read that as the end of the turn, and the cockpit parked a run whose session
 * was still working (#897). Raising the limit means constructing an `undici`
 * Agent, i.e. a new runtime dependency of the published CLI for a request the
 * platform can already make; `node:http` has no such default and needs nothing.
 *
 * The SSE subscription goes through the same door on purpose: `bodyTimeout` is
 * an inactivity timer, so a quiet session would lose its event stream after the
 * same 300 s — and the turn boundary now depends on that stream.
 */

/** A connection of our own, so a request never inherits `globalAgent`'s
 *  keep-alive socket timeout. The whole point here is a socket with no clock
 *  on it, and these are a handful of calls to a loopback server. */
const AGENT = new Agent({ keepAlive: false });

/** A response that arrived — status plus the raw body text, parsed by the caller. */
export interface OpencodeResponse {
  readonly status: number;
  readonly body: string;
}

export interface OpencodeRequestOptions {
  readonly method: string;
  /** JSON body; the request is sent without one (and without a content-type)
   *  when this is `undefined`. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * The request never reached an answer: the socket failed, the server went away,
 * the caller aborted. Distinct from an HTTP status, which IS an answer — the
 * runner treats a status error as a real failure and a transport error on a
 * session the event bus still shows alive as no evidence at all (#897).
 */
export class OpencodeTransportError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'OpencodeTransportError';
    this.cause = cause;
  }
}

/** `http.request`, with a malformed url/options surfacing as a rejection
 *  rather than a synchronous throw from inside the promise executor. */
function open(url: string, options: RequestOptions): ClientRequest | Error {
  try {
    return httpRequest(url, options);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** One request to the opencode server. Rejects only with `OpencodeTransportError`. */
export function opencodeRequest(url: string, opts: OpencodeRequestOptions): Promise<OpencodeResponse> {
  return new Promise<OpencodeResponse>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = open(url, { method: opts.method, headers, agent: AGENT, signal: opts.signal });
    if (req instanceof Error) {
      reject(new OpencodeTransportError(req));
      return;
    }
    req.once('error', (err: Error) => reject(new OpencodeTransportError(err)));
    req.once('response', (res: IncomingMessage) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.once('error', (err: Error) => reject(new OpencodeTransportError(err)));
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface OpencodeEventStreamOptions {
  readonly signal?: AbortSignal;
  /** One `\n\n`-delimited SSE frame, without its terminating blank line. */
  readonly onFrame: (frame: string) => void;
  /** Called once when the stream is over — server gone, aborted, or the
   *  response ended. Never called when the subscription never connected. */
  readonly onClose?: () => void;
}

/**
 * Subscribe to the server's event bus.
 *
 * Resolves `true` once the response HEADERS are in — callers await the
 * connection, not the stream, so no event the server emits afterwards can be
 * missed — and then drains frames in the background. Resolves `false` when the
 * subscription could not be established (server gone, aborted, non-2xx).
 */
export function openOpencodeEventStream(
  url: string,
  opts: OpencodeEventStreamOptions,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      opts.onClose?.();
    };
    const req = open(url, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      agent: AGENT,
      signal: opts.signal,
    });
    if (req instanceof Error) {
      resolve(false);
      return;
    }
    req.once('error', () => {
      // Before the response: never connected. After it: the stream is over.
      if (closed) return;
      resolve(false);
      close();
    });
    req.once('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        resolve(false);
        return;
      }
      resolve(true);
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          opts.onFrame(frame);
        }
      });
      res.once('error', close);
      res.once('end', close);
      res.once('close', close);
    });
    req.end();
  });
}

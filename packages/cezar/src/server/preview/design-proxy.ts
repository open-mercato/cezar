import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { isLoopbackHostHeader } from '../capabilities.ts';
import { PICKER_PATH, pickerScript } from './picker-script.ts';

/**
 * The Design Mode proxy (spec `.ai/specs/2026-10-09-design-mode.md`).
 *
 * The workspace Browser column frames a task's dev server, which is cross-origin to the cockpit —
 * so the cockpit cannot see what the user points at. This re-serves ONE loopback dev server on a
 * second loopback port with a picker script injected into its HTML, and the picker reports the
 * clicked element to the cockpit over `postMessage`.
 *
 * What makes it safe to exist, each of which is load-bearing:
 *
 *  - It is on its OWN origin (its own port), never the cockpit's. Spec `2026-10-07-task-workspace`
 *    §7 refused a preview proxy precisely because serving worktree content from the cockpit's
 *    origin would put it beside the API; a different port is a different origin, and the API's
 *    request-origin guard refuses mutating requests from it like from any other foreign origin.
 *  - It forwards ONLY to the loopback origin it was opened for. It is not an open proxy and can
 *    reach nothing a local page could not already reach directly.
 *  - It checks `Host` itself (`isLoopbackHostHeader`). Dev servers defend against DNS rebinding by
 *    checking `Host`; a proxy that rewrote `Host` without checking it first would be the bypass.
 *  - It rewrites `Origin` only when the request really came from its own pages. Any other origin
 *    reaches the app exactly as the browser sent it, so the app's own CORS/CSRF rules still hold.
 *  - It listens on 127.0.0.1 only, and only after a user switched Design Mode on.
 *
 * Lifetime — every way a listener stops: it has served nothing and holds no live socket for
 * `idleMs`; it is the least recently used when a new one would exceed `max`; or the server shuts
 * down (`closeAll`). Nothing is written to disk, so a restart simply forgets them and the cockpit
 * asks again.
 */

/** HTML is buffered whole to place the script tag. Past this it is passed through untouched —
 *  a page that large is not a dev server's document, and holding it would be the wrong trade. */
const HTML_BUFFER_MAX = 4 * 1024 * 1024;

const SCRIPT_TAG = `<script src="${PICKER_PATH}" data-cezar-design></script>`;

/** Hop-by-hop headers: they describe one connection and must not be copied onto the next. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

export type DesignProxyResult = { ok: true; origin: string } | { ok: false; reason: string };

export interface DesignProxiesOptions {
  /** How long an untouched listener with no live socket survives. */
  idleMs?: number;
  /** How many dev servers can be mirrored at once. */
  max?: number;
}

interface Entry {
  key: string;
  upstream: URL;
  parentOrigin: string;
  server: Server;
  port: number;
  lastUsed: number;
  sockets: Set<Duplex>;
}

/** `http://localhost:5173` from anything a user could have typed, or a reason it will not do. */
export function parseDesignTarget(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not an address' };
  }
  // http only: a loopback https dev server has a certificate this process has no reason to trust,
  // and silently skipping verification is not a decision to make on the user's behalf.
  if (url.protocol !== 'http:') return { ok: false, reason: 'Design Mode works on local http:// addresses' };
  if (!isLoopbackHostHeader(url.host)) return { ok: false, reason: 'Design Mode works on local addresses only' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'not an address' };
  return { ok: true, url: new URL(url.origin) };
}

function parseParentOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!isLoopbackHostHeader(url.host)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `[::1]` → `::1`: `URL.hostname` keeps the brackets, a socket address does not take them. */
function socketHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function portOf(url: URL): number {
  return url.port === '' ? 80 : Number(url.port);
}

/** Where the script tag goes: as early as a parser allows, so it is in place before the app's
 *  own scripts can throw. */
export function injectPicker(html: string): string {
  for (const pattern of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + SCRIPT_TAG + html.slice(at);
    }
  }
  return SCRIPT_TAG + html;
}

export class DesignProxies {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly max: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: DesignProxiesOptions = {}) {
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.max = options.max ?? 8;
  }

  /** How many listeners are open — for tests and for nothing else. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The proxy origin for `target`, opening a listener the first time it is asked for.
   *
   * `forbidden` are origins that must never be mirrored: the cockpit and the API themselves. A
   * mirrored cockpit would be this server's API re-served with `Origin` rewritten to look
   * same-origin — the request-origin guard, defeated by the very thing meant to stay outside it.
   */
  async open(input: { target: string; parentOrigin: string; forbidden?: readonly string[] }): Promise<DesignProxyResult> {
    const target = parseDesignTarget(input.target);
    if (!target.ok) return target;
    const parentOrigin = parseParentOrigin(input.parentOrigin);
    if (parentOrigin === null) return { ok: false, reason: 'Design Mode needs a local cockpit' };
    const upstream = target.url;
    const refused = new Set([parentOrigin, ...(input.forbidden ?? [])].flatMap(loopbackAliases));
    if (loopbackAliases(upstream.origin).some((alias) => refused.has(alias))) {
      return { ok: false, reason: 'Design Mode cannot be pointed at cezar itself' };
    }

    const key = `${upstream.origin}|${parentOrigin}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return { ok: true, origin: this.originOf(existing) };
    }

    while (this.entries.size >= this.max) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      this.close(oldest);
    }

    let entry: Entry;
    try {
      entry = await this.listen(key, upstream, parentOrigin);
    } catch (error) {
      return { ok: false, reason: `could not open a local port for Design Mode: ${(error as Error).message}` };
    }
    // Two requests for the same target can race the `listen`; the first one in wins and the
    // other's listener is closed rather than leaked.
    const raced = this.entries.get(key);
    if (raced) {
      entry.server.close();
      return { ok: true, origin: this.originOf(raced) };
    }
    this.entries.set(key, entry);
    this.startSweeper();
    return { ok: true, origin: this.originOf(entry) };
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) this.close(entry);
  }

  /** The hostname the user typed, with the proxy's port: cookies are scoped by host and not by
   *  port, so keeping `localhost` as `localhost` keeps the app's session. `[::1]` is the one
   *  exception — the listener is IPv4-only. */
  private originOf(entry: Entry): string {
    const host = entry.upstream.hostname.startsWith('[') ? '127.0.0.1' : entry.upstream.hostname;
    return `http://${host}:${entry.port}`;
  }

  private close(entry: Entry): void {
    this.entries.delete(entry.key);
    for (const socket of entry.sockets) socket.destroy();
    entry.server.close();
    entry.server.closeAllConnections?.();
    if (this.entries.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - this.idleMs;
      for (const entry of [...this.entries.values()]) {
        if (entry.sockets.size === 0 && entry.lastUsed < cutoff) this.close(entry);
      }
    }, Math.max(1_000, Math.min(60_000, this.idleMs)));
    // Never the reason a process stays alive.
    this.sweeper.unref();
  }

  private listen(key: string, upstream: URL, parentOrigin: string): Promise<Entry> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      const entry: Entry = { key, upstream, parentOrigin, server, port: 0, lastUsed: Date.now(), sockets: new Set() };
      server.on('request', (req, res) => this.handle(entry, req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(entry, req, socket, head));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('no port'));
          return;
        }
        entry.port = address.port;
        server.off('error', reject);
        // A listener error after boot must not take the process down with an unhandled event.
        server.on('error', () => {});
        resolve(entry);
      });
    });
  }

  /** The request's headers as the app should see them. */
  private forwardHeaders(entry: Entry, req: IncomingMessage): Record<string, string | string[]> {
    const own = `http://${req.headers.host}`;
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers.host = entry.upstream.host;
    // Only a request from the proxy's OWN pages is presented as same-origin. A foreign origin is
    // passed through untouched so the app's CORS and CSRF checks judge it as they always would.
    if (typeof headers.origin === 'string' && headers.origin === own) headers.origin = entry.upstream.origin;
    if (typeof headers.referer === 'string' && headers.referer.startsWith(`${own}/`)) {
      headers.referer = entry.upstream.origin + headers.referer.slice(own.length);
    }
    return headers;
  }

  private handle(entry: Entry, req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    entry.lastUsed = Date.now();
    const own = `http://${req.headers.host}`;

    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === PICKER_PATH) {
      res
        .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        .end(pickerScript({ parentOrigin: entry.parentOrigin, upstreamOrigin: entry.upstream.origin }));
      return;
    }

    const headers = this.forwardHeaders(entry, req);
    // Uncompressed, so an HTML answer can be read and given its script tag. Loopback: the bytes
    // saved by compression were never crossing a network.
    headers['accept-encoding'] = 'identity';

    const outgoing = httpRequest(
      { host: socketHost(entry.upstream), port: portOf(entry.upstream), method: req.method, path: req.url, headers },
      (incoming) => {
        const answer: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          answer[name] = value;
        }
        // A redirect to the app's own origin stays inside the proxy; one that leaves it, leaves.
        if (typeof answer.location === 'string' && answer.location.startsWith(entry.upstream.origin)) {
          answer.location = own + answer.location.slice(entry.upstream.origin.length);
        }
        const status = incoming.statusCode ?? 502;
        const type = String(incoming.headers['content-type'] ?? '');
        const encoded = incoming.headers['content-encoding'];
        const html = /^text\/html\b/i.test(type) && (encoded === undefined || encoded === 'identity') && req.method !== 'HEAD';
        if (!html) {
          res.writeHead(status, answer);
          incoming.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let passthrough = false;
        incoming.on('data', (chunk: Buffer) => {
          if (passthrough) {
            res.write(chunk);
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
          if (size > HTML_BUFFER_MAX) {
            passthrough = true;
            res.writeHead(status, answer);
            res.write(Buffer.concat(chunks));
            chunks.length = 0;
          }
        });
        incoming.on('end', () => {
          if (passthrough) {
            res.end();
            return;
          }
          const body = Buffer.from(injectPicker(Buffer.concat(chunks).toString('utf8')), 'utf8');
          delete answer['content-length'];
          res.writeHead(status, { ...answer, 'content-length': String(body.length) });
          res.end(body);
        });
        incoming.on('error', () => res.destroy());
      },
    );
    outgoing.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`Design Mode could not reach ${entry.upstream.origin} — is the app still running?`);
    });
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  }

  /** WebSocket upgrades (a dev server's hot reload) are spliced through byte for byte. */
  private upgrade(entry: Entry, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isLoopbackHostHeader(req.headers.host)) {
      socket.destroy();
      return;
    }
    entry.lastUsed = Date.now();
    const headers = this.forwardHeaders(entry, req);
    // `forwardHeaders` drops hop-by-hop headers, and an upgrade is made of exactly two of them.
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';

    const upstream: Socket = connect(portOf(entry.upstream), socketHost(entry.upstream));
    const release = () => {
      entry.sockets.delete(socket);
      entry.lastUsed = Date.now();
      socket.destroy();
      upstream.destroy();
    };
    entry.sockets.add(socket);
    upstream.on('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', release);
    upstream.on('close', release);
    socket.on('error', release);
    socket.on('close', release);
  }
}

/** Every loopback spelling of an origin's host, so `localhost:4321` and `127.0.0.1:4321` are
 *  recognised as the same listener when deciding what must not be mirrored. */
function loopbackAliases(origin: string): string[] {
  try {
    const url = new URL(origin);
    const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
    return isLoopbackHostHeader(url.host) ? [`loopback:${port}`] : [`${url.hostname}:${port}`];
  } catch {
    return [];
  }
}

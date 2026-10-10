import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { parseDesignTarget } from './design-proxy.ts';

/**
 * The preview gateway (spec `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * On a hosted cockpit a task's app listens on the HOST's loopback, which the viewer's browser
 * cannot reach — `http://localhost:3000` there means the viewer's own machine. The gateway
 * re-serves one such app on a port the front in front of cezar forwards, so the Browser column
 * can frame it.
 *
 * Why this is not the proxy spec `2026-10-07-task-workspace` §7 refused, each load-bearing:
 *
 *  - It is NEVER on the cockpit's origin. Every app gets a port of its own, and a different port
 *    is a different origin: a framed page cannot read the cockpit, and the API's request-origin
 *    guard refuses its mutating requests like any other foreign origin's.
 *  - It listens only on ports an operator named (`CEZ_PREVIEW_PORTS`). Unset, there is no
 *    gateway and nothing listens — the exposure is opted into by whoever configures the front.
 *  - It authenticates every request itself. The front's login covers the cockpit, not these
 *    ports, so a preview is opened with a one-time ticket only the authenticated cockpit can
 *    obtain, exchanged for a cookie scoped to that one port. No ticket, no cookie: 401.
 *  - It forwards ONLY to the loopback origin it was opened for, and never to cezar itself or to
 *    another gateway port. It is not an open proxy.
 *
 * Lifetime — every way a listener stops: nothing has used it for `idleMs` and it holds no live
 * socket; it is the least recently used when the pool is full; or the server shuts down
 * (`closeAll`). Nothing is written to disk.
 */

/** Hop-by-hop headers: they describe one connection and must not be copied onto the next. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/** The query parameter a ticket rides in on. Stripped by the redirect that follows. */
export const TICKET_PARAM = '__cez_preview';
const TICKET_TTL_MS = 60_000;
/** Outstanding tickets per app. A cockpit asks before every load, so this only bounds abuse. */
const MAX_TICKETS = 32;

export type PreviewGatewayResult =
  | { ok: true; origin: string; ticket: string }
  | { ok: false; code: 'disabled' | 'invalid' | 'busy'; reason: string };

export interface PreviewGatewaysOptions {
  /** The ports the gateway may listen on. Empty: the gateway does not exist. */
  ports: readonly number[];
  /**
   * The port a browser reaches each of those at, position for position, when the front in front
   * of cezar cannot use the same number — a front on the same host cannot bind a port cezar
   * already holds. Absent, or of a different length: the same numbers.
   */
  publicPorts?: readonly number[];
  /** The interface to bind — the one cezar itself is bound to, so the same front reaches both. */
  bindHost?: string;
  idleMs?: number;
}

interface Entry {
  upstream: URL;
  /** The origin a browser reaches this listener at: the cockpit's scheme and hostname, this port. */
  publicOrigin: string;
  server: Server;
  port: number;
  secret: string;
  tickets: Map<string, number>;
  lastUsed: number;
  sockets: Set<Duplex>;
}

/**
 * `8500-8519`, `8500,8501`, or a mix → the ports, in order, without duplicates. Anything that is
 * not a port above the privileged range is dropped: a typo must not make cezar try to bind :80.
 */
export function parsePreviewPorts(raw: string | undefined): number[] {
  const ports: number[] = [];
  for (const part of (raw ?? '').split(',')) {
    const range = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    for (let port = from; port <= to && ports.length < 256; port += 1) {
      if (port >= 1024 && port <= 65535 && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

function socketHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function portOf(url: URL): number {
  return url.port === '' ? 80 : Number(url.port);
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A stable first choice of port per app, so a reopened preview lands on the origin its
 *  cookies and local storage were written under. */
function preferredIndex(key: string, size: number): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % size;
}

export class PreviewGateways {
  private readonly entries = new Map<string, Entry>();
  private readonly ports: readonly number[];
  private readonly publicPorts: readonly number[];
  private readonly bindHost: string;
  private readonly idleMs: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: PreviewGatewaysOptions) {
    this.ports = options.ports;
    this.publicPorts = options.publicPorts?.length === options.ports.length ? options.publicPorts : options.ports;
    this.bindHost = options.bindHost ?? '127.0.0.1';
    this.idleMs = options.idleMs ?? 30 * 60_000;
  }

  get enabled(): boolean {
    return this.ports.length > 0;
  }

  /** How many listeners are open — for tests and for nothing else. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * A gateway origin for `target` and a ticket that opens it once.
   *
   * `parentOrigin` is the cockpit as the viewer's browser reaches it; the gateway is reached at
   * the same scheme and hostname on its own port, which is what keeps the two same-SITE (so the
   * cookie is sent inside the frame) and never same-ORIGIN. `forbiddenPorts` are loopback ports
   * that must never be re-served: cezar's own.
   */
  async open(input: { target: string; parentOrigin: string; forbiddenPorts?: readonly number[] }): Promise<PreviewGatewayResult> {
    if (!this.enabled) {
      return { ok: false, code: 'disabled', reason: 'this cockpit has no preview gateway (CEZ_PREVIEW_PORTS is not set)' };
    }
    const target = parseDesignTarget(input.target);
    if (!target.ok) return { ok: false, code: 'invalid', reason: 'a preview needs a local http:// address' };
    let parent: URL;
    try {
      parent = new URL(input.parentOrigin);
    } catch {
      return { ok: false, code: 'invalid', reason: 'not a cockpit origin' };
    }
    if (parent.protocol !== 'http:' && parent.protocol !== 'https:') {
      return { ok: false, code: 'invalid', reason: 'not a cockpit origin' };
    }
    const upstream = target.url;
    const refused = new Set([...(input.forbiddenPorts ?? []), ...this.ports]);
    if (refused.has(portOf(upstream))) {
      return { ok: false, code: 'invalid', reason: 'a preview cannot be pointed at cezar itself' };
    }

    // One listener per app AND per way of reaching the cockpit: the public origin is baked into
    // the redirects and `Origin` rewrites, and two hostnames for one cockpit must not share them.
    const key = `${upstream.origin}|${parent.protocol}//${parent.hostname}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const opened = await this.listen(key, upstream, parent);
      if (!opened) {
        return { ok: false, code: 'busy', reason: 'every preview port is in use — close a preview and retry' };
      }
      // Two requests for the same app can race the `listen`; the first one in wins.
      const raced = this.entries.get(key);
      if (raced) {
        opened.server.close();
        entry = raced;
      } else {
        this.entries.set(key, opened);
        this.startSweeper();
        entry = opened;
      }
    }
    entry.lastUsed = Date.now();
    const now = Date.now();
    for (const [ticket, expires] of entry.tickets) if (expires < now) entry.tickets.delete(ticket);
    while (entry.tickets.size >= MAX_TICKETS) entry.tickets.delete(entry.tickets.keys().next().value as string);
    const ticket = randomBytes(32).toString('base64url');
    entry.tickets.set(ticket, now + TICKET_TTL_MS);
    return { ok: true, origin: entry.publicOrigin, ticket };
  }

  closeAll(): void {
    for (const [key, entry] of [...this.entries]) this.close(key, entry);
  }

  private close(key: string, entry: Entry): void {
    this.entries.delete(key);
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
      for (const [key, entry] of [...this.entries]) {
        if (entry.sockets.size === 0 && entry.lastUsed < cutoff) this.close(key, entry);
      }
    }, Math.max(1_000, Math.min(60_000, this.idleMs)));
    // Never the reason a process stays alive.
    this.sweeper.unref();
  }

  /** A listener on a free pool port — the app's usual one when it is free — or null when the
   *  pool is exhausted even after giving up the least recently used idle preview. */
  private async listen(key: string, upstream: URL, parent: URL): Promise<Entry | null> {
    const inUse = () => new Set([...this.entries.values()].map((entry) => entry.port));
    if (inUse().size >= this.ports.length) {
      const idle = [...this.entries].filter(([, entry]) => entry.sockets.size === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) return null;
      this.close(idle[0], idle[1]);
    }
    const start = preferredIndex(key, this.ports.length);
    for (let step = 0; step < this.ports.length; step += 1) {
      const port = this.ports[(start + step) % this.ports.length]!;
      if (inUse().has(port)) continue;
      const entry = await this.bind(port, upstream, parent);
      if (entry) return entry;
    }
    return null;
  }

  private bind(port: number, upstream: URL, parent: URL): Promise<Entry | null> {
    return new Promise((resolve) => {
      const server = createServer();
      const entry: Entry = {
        upstream,
        publicOrigin: `${parent.protocol}//${parent.hostname}:${this.publicPorts[this.ports.indexOf(port)] ?? port}`,
        server,
        port,
        secret: randomBytes(32).toString('base64url'),
        tickets: new Map(),
        lastUsed: Date.now(),
        sockets: new Set(),
      };
      server.on('request', (req, res) => this.handle(entry, req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(entry, req, socket, head));
      // Something else on the host holds this port: not an error, just not ours — try the next.
      server.once('error', () => resolve(null));
      server.listen(port, this.bindHost, () => {
        // Port 0 is not a pool an operator can name; it is how a test lets the OS choose.
        const address = server.address();
        if (port === 0 && address !== null && typeof address !== 'string') {
          entry.port = address.port;
          entry.publicOrigin = `${parent.protocol}//${parent.hostname}:${address.port}`;
        }
        server.removeAllListeners('error');
        // A listener error after boot must not take the process down with an unhandled event.
        server.on('error', () => {});
        resolve(entry);
      });
    });
  }

  private cookieName(entry: Entry): string {
    // Cookies are scoped by host and NOT by port, so the name carries the port: one preview's
    // session must not open another's, and none of them may collide with the app's own cookies.
    return `__cez_pv_${entry.port}`;
  }

  /** The request's cookies with the gateway's own removed, and whether that one was valid. */
  private readCookies(entry: Entry, req: IncomingMessage): { authorized: boolean; forwarded: string | undefined } {
    const name = this.cookieName(entry);
    let authorized = false;
    const kept: string[] = [];
    for (const pair of (req.headers.cookie ?? '').split(';')) {
      const trimmed = pair.trim();
      if (trimmed === '') continue;
      const eq = trimmed.indexOf('=');
      const cookie = eq === -1 ? trimmed : trimmed.slice(0, eq);
      if (cookie.startsWith('__cez_pv_')) {
        if (cookie === name && sameSecret(trimmed.slice(eq + 1), entry.secret)) authorized = true;
        continue;
      }
      kept.push(trimmed);
    }
    return { authorized, forwarded: kept.length > 0 ? kept.join('; ') : undefined };
  }

  /** Spend a ticket from the request's query. Answers the URL without it, or null. */
  private redeem(entry: Entry, req: IncomingMessage): string | null {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket === null) return null;
    const expires = entry.tickets.get(ticket);
    entry.tickets.delete(ticket);
    if (expires === undefined || expires < Date.now()) return null;
    url.searchParams.delete(TICKET_PARAM);
    return url.pathname + url.search;
  }

  /** The request's headers as the app should see them. */
  private forwardHeaders(entry: Entry, req: IncomingMessage, cookies: string | undefined): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === 'cookie') continue;
      headers[name] = value;
    }
    if (cookies !== undefined) headers.cookie = cookies;
    headers.host = entry.upstream.host;
    // Only a request from the gateway's OWN pages is presented as same-origin. A foreign origin
    // is passed through untouched so the app's CORS and CSRF checks judge it as they always would.
    if (headers.origin === entry.publicOrigin) headers.origin = entry.upstream.origin;
    if (typeof headers.referer === 'string' && headers.referer.startsWith(`${entry.publicOrigin}/`)) {
      headers.referer = entry.upstream.origin + headers.referer.slice(entry.publicOrigin.length);
    }
    return headers;
  }

  private handle(entry: Entry, req: IncomingMessage, res: ServerResponse): void {
    const { authorized, forwarded } = this.readCookies(entry, req);
    if (!authorized) {
      const location = this.redeem(entry, req);
      if (location === null) {
        res
          .writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          .end('This preview is opened from the cezar cockpit. Reload it there.');
        return;
      }
      entry.lastUsed = Date.now();
      const secure = entry.publicOrigin.startsWith('https:') ? '; Secure' : '';
      res
        .writeHead(302, {
          location,
          'set-cookie': `${this.cookieName(entry)}=${entry.secret}; Path=/; HttpOnly; SameSite=Lax${secure}`,
          'cache-control': 'no-store',
        })
        .end();
      return;
    }
    entry.lastUsed = Date.now();

    const outgoing = httpRequest(
      {
        host: socketHost(entry.upstream),
        port: portOf(entry.upstream),
        method: req.method,
        path: req.url,
        headers: this.forwardHeaders(entry, req, forwarded),
      },
      (incoming) => {
        const answer: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          answer[name] = value;
        }
        // A redirect to the app's own origin stays inside the gateway; one that leaves it, leaves.
        if (typeof answer.location === 'string' && answer.location.startsWith(entry.upstream.origin)) {
          answer.location = entry.publicOrigin + answer.location.slice(entry.upstream.origin.length);
        }
        res.writeHead(incoming.statusCode ?? 502, answer);
        incoming.pipe(res);
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
        .end(`The preview could not reach ${entry.upstream.origin} — is the app still running?`);
    });
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  }

  /** WebSocket upgrades (a dev server's hot reload) are spliced through byte for byte. */
  private upgrade(entry: Entry, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { authorized, forwarded } = this.readCookies(entry, req);
    if (!authorized) {
      socket.destroy();
      return;
    }
    entry.lastUsed = Date.now();
    const headers = this.forwardHeaders(entry, req, forwarded);
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

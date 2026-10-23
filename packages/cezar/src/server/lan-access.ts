/**
 * LAN access (spec `2026-10-20-lan-basic-auth-https`): an opt-in, HTTPS-only listener on this
 * machine's LAN addresses, behind HTTP Basic Auth.
 *
 * The loopback listener is never touched — no rebind, no TLS, no credential. That is what keeps
 * the CLI, `cez task`, the Vite dev proxy, the desktop shell and every supervisor working as
 * before, and it is why no internal bearer token is needed: loopback stays guarded by the #426
 * Host/Origin checks exactly as it is today. LAN sockets are fed into the SAME `http.Server`
 * after the TLS handshake, so routes, SSE and keep-alive need no second copy (WebSocket upgrades are refused on the LAN);
 * `isLanSocket` is how the request side tells the two apart.
 */

import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import type { SecurityLanStatus, SetSecurityLanInput } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { normalizeHostname } from './capabilities.ts';

export interface TlsMaterialLike { cert: string; key: string; fingerprint256: string }

export interface LanAccessDeps {
  /** Hashing and certificates live in `auth-crypto.ts` / `certs.ts`; injected so tests stay fast. */
  hashPassword(password: string): Promise<{ salt: string; hash: string }>;
  verifyPassword(password: string, stored: { salt: string; hash: string }): Promise<boolean>;
  parseBasicAuth(header: string | undefined): { username: string; password: string } | null;
  safeEqualString(a: string, b: string): boolean;
  loadOrCreateCert(dir: string, hosts: string[]): TlsMaterialLike;
  /** False on a hosted cockpit, whose reverse proxy owns the perimeter. */
  available(): boolean;
  config?: { load: typeof loadWorkspaceConfig; mergeWrite: typeof mergeWriteWorkspaceConfig };
  /** Non-loopback IPv4 addresses to bind; defaults to `lanAddresses()`. */
  addresses?: () => string[];
  certDir?: () => string;
  now?: () => number;
}

export type LanVerdict = 'ok' | 'challenge' | 'throttled';
export type LanApplyResult = { ok: true } | { ok: false; status: 400 | 409; error: string };

/** Failed sign-ins per client IP before it is told to wait; scrypt alone is a slow brake. */
const MAX_FAILURES = 10;
/** A well-formed hash nothing verifies against, so an unconfigured server still pays for scrypt. */
const DECOY_HASH = { salt: '0'.repeat(32), hash: '0'.repeat(128) };
/** A LAN connection must send its first byte within this, or it is closed (slowloris). */
const FIRST_BYTE_TIMEOUT_MS = 10_000;
const FAILURE_WINDOW_MS = 5 * 60_000;

/** This machine's reachable IPv4 addresses (no loopback, no 169.254 link-local). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      if (!out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}

/** The names a LAN browser may reach us by: the bound IPs, plus the machine name and its mDNS
 *  `.local` form when the name is a plain DNS label. */
function lanHostnames(addresses: string[]): string[] {
  const name = osHostname().toLowerCase();
  const names = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? [name, `${name}.local`] : [];
  return [...addresses, ...names];
}

export class LanAccess {
  private listeners: NetServer[] = [];
  private readonly lanSockets = new Set<TLSSocket>();
  /** Every TCP connection the LAN listeners accepted, handshake done or not: `close()` waits on them. */
  private readonly rawSockets = new Set<Socket>();
  /** SHA-256 of `Authorization` headers that verified, so a page's hundred requests cost one
   *  scrypt. Cleared on every credential change. */
  private readonly verified = new Set<string>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  private allowedHosts = new Set<string>();
  private boundAddresses: string[] = [];
  private fingerprint: string | null = null;
  private lastError: string | null = null;
  private auth: { username: string; salt: string; hash: string } | undefined;
  private server: HttpServer | undefined;
  private port = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly redirector = createHttpServer((req, res) => this.redirectToHttps(req, res));

  constructor(private readonly deps: LanAccessDeps) {}

  private get config() {
    return this.deps.config ?? { load: loadWorkspaceConfig, mergeWrite: mergeWriteWorkspaceConfig };
  }

  /** Bind the LAN side to `server` once it listens; reopens the listener a saved config asks for. */
  attach(server: HttpServer, port: number): Promise<void> {
    this.server = server;
    this.port = port;
    server.once('close', () => void this.closeListeners());
    return this.serialize(async () => {
      if (!this.deps.available()) return;
      const security = (await this.config.load()).security;
      this.auth = security?.auth;
      if (security?.lanAccess && this.auth) await this.openListeners();
    });
  }

  isLanSocket(socket: unknown): boolean {
    return this.lanSockets.has(socket as TLSSocket);
  }

  /** A LAN request's `Host` must name one of the addresses we bound — a DNS-rebound name never does. */
  isAllowedHost(host: string | undefined): boolean {
    return !!host && this.allowedHosts.has(normalizeHostname(host));
  }

  async authorize(header: string | undefined, remoteIp: string | undefined): Promise<LanVerdict> {
    if (this.isVerified(header)) return 'ok';
    const ip = remoteIp ?? '';
    const now = this.now();
    const failure = this.failures.get(ip);
    if (failure && now - failure.since > FAILURE_WINDOW_MS) this.failures.delete(ip);
    if ((this.failures.get(ip)?.count ?? 0) >= MAX_FAILURES) return 'throttled';
    const credentials = this.deps.parseBasicAuth(header);
    if (!credentials) return 'challenge'; // the browser's first, credential-less request is no failure
    const auth = this.auth;
    // Both checks always run, scrypt included: a wrong username must cost what a wrong password
    // does, or response time tells a LAN client which usernames exist.
    const userMatches = this.deps.safeEqualString(credentials.username, auth?.username ?? '');
    const passwordMatches = await this.deps.verifyPassword(credentials.password, auth ?? DECOY_HASH);
    const ok = !!auth && userMatches && passwordMatches;
    if (ok && auth === this.auth) {
      this.verified.add(digest(header!));
      this.failures.delete(ip);
      return 'ok';
    }
    const entry = this.failures.get(ip) ?? { count: 0, since: now };
    entry.count += 1;
    this.failures.set(ip, entry);
    return entry.count >= MAX_FAILURES ? 'throttled' : 'challenge';
  }

  /** The synchronous check the WebSocket upgrade guard can afford: the page that opens the socket
   *  already authenticated over HTTP, so its header is in the cache. Anything else fails closed. */
  isVerified(header: string | undefined): boolean {
    return !!header && this.verified.has(digest(header));
  }

  async status(editable: boolean): Promise<SecurityLanStatus> {
    const security = (await this.config.load()).security;
    const active = this.listeners.length > 0;
    const lanIp = (active ? this.boundAddresses : this.addresses())[0] ?? null;
    return {
      available: this.deps.available(),
      editable: editable && this.deps.available(),
      lanAccess: security?.lanAccess === true,
      active,
      authConfigured: !!security?.auth,
      username: security?.auth?.username ?? null,
      port: this.port,
      tlsEnabled: active,
      lanIp,
      lanUrls: active ? this.boundAddresses.map((address) => `https://${address}:${this.port}`) : [],
      certFingerprint: active ? this.fingerprint : null,
      error: this.lastError,
    };
  }

  apply(input: SetSecurityLanInput): Promise<LanApplyResult> {
    return this.serialize(async (): Promise<LanApplyResult> => {
      if (!this.deps.available()) {
        return { ok: false, status: 409, error: 'LAN access is not available on this server' };
      }
      const stored = (await this.config.load()).security?.auth;
      if (input.username !== undefined && input.password === undefined && stored === undefined) {
        return { ok: false, status: 400, error: 'set a password together with the username' };
      }
      if (input.lanAccess && !stored && input.password === undefined) {
        return { ok: false, status: 400, error: 'a username and password are required to allow LAN access' };
      }
      let auth = stored;
      if (input.password !== undefined) {
        auth = { username: input.username!, ...await this.deps.hashPassword(input.password) };
      } else if (input.username !== undefined && stored) {
        auth = { ...stored, username: input.username };
      }
      const written = await this.config.mergeWrite((config: WorkspaceConfig) => {
        config.security = { ...config.security, lanAccess: input.lanAccess, ...(auth ? { auth } : {}) };
      });
      const credentialsChanged = auth !== stored;
      this.auth = written.security?.auth;
      if (credentialsChanged) this.dropSessions();
      if (input.lanAccess) {
        // New credentials re-key the listener too: every open LAN socket must sign in again.
        if (credentialsChanged || this.listeners.length === 0) {
          await this.closeListeners();
          await this.openListeners();
        }
      } else {
        await this.closeListeners();
        this.lastError = null;
      }
      return { ok: true };
    });
  }

  /** `cezar auth reset` and tests: drop the listener and every LAN session. */
  close(): Promise<void> {
    return this.serialize(() => this.closeListeners());
  }

  private async openListeners(): Promise<void> {
    if (!this.server) return;
    const addresses = this.addresses();
    if (addresses.length === 0) {
      this.lastError = 'no LAN address found on this machine';
      return;
    }
    let material: TlsMaterialLike;
    try {
      material = this.deps.loadOrCreateCert(this.certDir(), ['localhost', '127.0.0.1', ...lanHostnames(addresses)]);
    } catch (error) {
      this.lastError = `could not prepare the TLS certificate: ${(error as Error).message}`;
      return;
    }
    const server = this.server;
    const tls = createTlsServer({ cert: material.cert, key: material.key }, (socket) => {
      this.lanSockets.add(socket);
      socket.once('close', () => this.lanSockets.delete(socket));
      server.emit('connection', socket);
    });
    tls.on('tlsClientError', () => undefined); // a browser rejecting the self-signed cert, a port scan
    const bound: string[] = [];
    const failed: string[] = [];
    for (const address of addresses) {
      const listener = createNetServer((socket) => this.route(socket, tls));
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(this.port, address, () => { listener.off('error', reject); resolve(); });
        });
        listener.on('error', () => undefined);
        this.listeners.push(listener);
        bound.push(address);
      } catch (error) {
        failed.push(`${address}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      }
    }
    this.boundAddresses = bound;
    this.allowedHosts = new Set(lanHostnames(bound));
    this.fingerprint = material.fingerprint256;
    this.lastError = failed.length > 0 ? `could not listen on ${failed.join(', ')}` : null;
  }

  /** One port, two protocols: a TLS ClientHello starts with 0x16; anything else is a browser that
   *  typed `http://`, which gets a redirect rather than a reset. */
  private route(socket: Socket, tls: ReturnType<typeof createTlsServer>): void {
    this.rawSockets.add(socket);
    socket.once('close', () => this.rawSockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => socket.destroy());
    socket.once('data', (chunk) => {
      // TLS and HTTP enforce their own handshake and header timeouts from here on.
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === 0x16 ? tls : this.redirector).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  }

  private redirectToHttps(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host;
    if (!this.isAllowedHost(host)) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('cezar on this port speaks HTTPS only\n');
      return;
    }
    res.writeHead(308, { location: `https://${host}${req.url ?? '/'}`, connection: 'close' }).end();
  }

  private async closeListeners(): Promise<void> {
    const listeners = this.listeners;
    this.listeners = [];
    this.boundAddresses = [];
    this.allowedHosts = new Set();
    this.dropSessions();
    for (const socket of this.rawSockets) socket.destroy();
    this.rawSockets.clear();
    await Promise.all(listeners.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))));
  }

  /** Every LAN socket, keep-alive, SSE stream and WebSocket included, has to sign in again. */
  private dropSessions(): void {
    this.verified.clear();
    for (const socket of this.lanSockets) socket.destroy();
    this.lanSockets.clear();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private addresses(): string[] {
    return (this.deps.addresses ?? lanAddresses)();
  }

  private certDir(): string {
    return this.deps.certDir?.() ?? join(cezarHomeDir(), 'certs');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function digest(header: string): string {
  return createHash('sha256').update(header).digest('hex');
}

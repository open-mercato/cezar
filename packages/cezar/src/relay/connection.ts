import { randomUUID } from 'node:crypto';
import type { RelayStatus } from '@open-mercato/cezar-contract';
import type { RelayIdentity } from './identity.ts';
import type { RelaySocket, SocketFactory, SocketRefusal } from './socket.ts';
import { LIMIT_DEFAULTS, RELAY_PROTOCOL_VERSION, RENDEZVOUS_FRAME_BYTES, b64u, fromB64u, proofHeaders, socketOrigin, socketProof } from './wire.ts';

export const PING_MS = 45_000;
export const PONG_WAIT_MS = 15_000;
export const COMMAND_TIMEOUT_MS = 10_000;
const RESET_ATTEMPTS_AFTER_MS = 60_000;
const MAX_BACKOFF_S = 300;
const KILL_SWITCH_MIN_MS = 5 * 60_000;
const KILL_SWITCH_MAX_MS = 15 * 60_000;

export interface RelayLimits {
  frameBytes: number;
  controlBytes: number;
  devices: number;
}

/** `hello` limits override the table; an absent key falls back to it (§ 4, § 8). */
export function limitsFrom(hello: { limits?: unknown }): RelayLimits {
  const live = (hello.limits && typeof hello.limits === 'object' ? hello.limits : {}) as Record<string, unknown>;
  const pick = (name: keyof RelayLimits): number => {
    const value = live[name];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : LIMIT_DEFAULTS[name];
  };
  return { frameBytes: pick('frameBytes'), controlBytes: pick('controlBytes'), devices: pick('devices') };
}

/** Attempt `n` waits a uniform time from 1 s to `min(300 s, 2^n s)`. */
export const backoffMs = (attempt: number, random: () => number): number =>
  (1 + random() * (Math.min(MAX_BACKOFF_S, 2 ** attempt) - 1)) * 1000;

export class RelayCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RelayConnectionDeps {
  origin: string;
  identity: RelayIdentity;
  open: SocketFactory;
  random?: () => number;
  /** Every saved device, for the one `device-sync` after connecting. */
  syncDevices(): { device: string; key: string }[];
  onUp(phones: string[]): void;
  onDown(): void;
  onPhoneJoined(deviceId: string): void;
  onPhoneLeft(deviceId: string): void;
  onData(deviceId: string, ciphertext: Buffer): void;
  onStatus(status: RelayStatus, detail?: string): void;
}

interface PendingCommand {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** The long-lived `/v1/cezar/<cezarId>` socket: `cezar serve` only, while a device is paired. */
export class RelayConnection {
  private socket: RelaySocket | undefined;
  private live = false;
  private stopped = false;
  private attempts = 0;
  private connectedAt = 0;
  private clockSkewS = 0;
  private proofRetried = false;
  private retryAfterS: number | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private readonly commands = new Map<string, PendingCommand>();
  private readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  limits: RelayLimits = { ...LIMIT_DEFAULTS };

  constructor(private readonly deps: RelayConnectionDeps) {}

  get ready(): boolean {
    return this.live;
  }

  start(): void {
    this.stopped = false;
    if (!this.socket && !this.reconnectTimer) this.connect();
  }

  /** Closes for good. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    const socket = this.socket;
    this.teardown();
    this.deps.onStatus('off');
    socket?.close(1000);
  }

  whenReady(timeoutMs: number): Promise<void> {
    if (this.live) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== entry);
        reject(new RelayCommandError('unreachable'));
      }, timeoutMs);
      const entry = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      this.readyWaiters.push(entry);
    });
  }

  /** Sends one command and resolves on its `ack`; rejects on `error`, a lost socket or a timeout. */
  command(frame: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
    const id = randomUUID();
    const text = JSON.stringify({ ...frame, id });
    if (!this.live || !this.socket) return Promise.reject(new RelayCommandError('unreachable'));
    if (Buffer.byteLength(text) > this.limits.controlBytes) return Promise.reject(new RelayCommandError('bad-command'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(id);
        reject(new RelayCommandError('timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.commands.set(id, { resolve, reject, timer });
      this.socket?.send(text);
    });
  }

  /** Only a session calls this, which is what keeps § 6 rule 5 true. */
  sendData(deviceId: string, ciphertext: Buffer): void {
    if (!this.live) return;
    this.socket?.send(Buffer.concat([Buffer.from([1]), Buffer.from(deviceId, 'base64url'), ciphertext]));
  }

  private connect(): void {
    if (this.stopped) return;
    this.deps.onStatus('connecting');
    const { identity, origin } = this.deps;
    const time = Math.floor(Date.now() / 1000) + this.clockSkewS;
    const proof = socketProof('cezar', identity.cezarId, '-', time);
    let socket: RelaySocket | undefined;
    const own = (fn: () => void) => { if (socket === undefined || socket === this.socket) fn(); };
    socket = this.deps.open(
      `${socketOrigin(origin)}/v1/cezar/${identity.cezarId}`,
      { ...proofHeaders(identity.edSeed, proof, time) },
      {
        onOpen: () => {},
        onMessage: (data) => own(() => this.onMessage(data)),
        onClose: (code) => own(() => this.onClose(code)),
        onRefused: (refusal) => own(() => this.onRefused(refusal)),
      },
    );
    this.socket = socket;
  }

  private onMessage(data: string | Buffer): void {
    if (typeof data !== 'string') {
      this.onBinary(data);
      return;
    }
    if (data === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (frame.t) {
      case 'hello': this.onHello(frame); break;
      case 'phone-joined': if (typeof frame.device === 'string') this.deps.onPhoneJoined(frame.device); break;
      case 'phone-left': if (typeof frame.device === 'string') this.deps.onPhoneLeft(frame.device); break;
      case 'ack': this.settle(frame.id); break;
      case 'error': this.settle(frame.id, typeof frame.code === 'string' ? frame.code : 'internal'); break;
      case 'closing': if (typeof frame.retryAfter === 'number') this.retryAfterS = frame.retryAfter; break;
      default: break; // Unknown `t` values are ignored, § 4.
    }
  }

  private onBinary(data: Buffer): void {
    if (!this.live || data.length < 17 || data[0] !== 1) return;
    this.deps.onData(b64u(data.subarray(1, 17)), data.subarray(17));
  }

  private onHello(frame: Record<string, unknown>): void {
    if (frame.protocol !== RELAY_PROTOCOL_VERSION) {
      this.halt('update-required', 'the relay speaks another protocol version');
      return;
    }
    const limits = limitsFrom(frame);
    if (limits.frameBytes < RENDEZVOUS_FRAME_BYTES) {
      this.halt('error', 'the relay reported an unusable frame size');
      return;
    }
    this.limits = limits;
    this.live = true;
    this.proofRetried = false;
    this.connectedAt = Date.now();
    this.deps.onStatus('connected');
    this.armPing();
    const phones = Array.isArray(frame.phones) ? frame.phones.filter((id): id is string => typeof id === 'string' && fromB64u(id, 16) !== null) : [];
    this.deps.onUp(phones);
    void this.command({ t: 'device-sync', devices: this.deps.syncDevices() }).catch(() => {});
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
  }

  private settle(id: unknown, code?: string): void {
    if (typeof id !== 'string') return;
    const pending = this.commands.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.commands.delete(id);
    if (code) pending.reject(new RelayCommandError(code));
    else pending.resolve();
  }

  private armPing(): void {
    this.pingTimer = setInterval(() => {
      this.socket?.send('ping');
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = undefined;
        this.socket?.terminate();
      }, PONG_WAIT_MS);
      this.pongTimer.unref?.();
    }, PING_MS);
    this.pingTimer.unref?.();
  }

  private teardown(): void {
    const wasLive = this.live;
    this.live = false;
    this.socket = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    for (const pending of this.commands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelayCommandError('unreachable'));
    }
    this.commands.clear();
    if (wasLive) this.deps.onDown();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private backoff(): void {
    if (this.connectedAt && Date.now() - this.connectedAt >= RESET_ATTEMPTS_AFTER_MS) this.attempts = 0;
    this.connectedAt = 0;
    this.attempts += 1;
    this.schedule(backoffMs(this.attempts, this.deps.random ?? Math.random));
  }

  /** Stop reconnecting and say why; only a new start clears it. */
  private halt(status: RelayStatus, detail?: string): void {
    const socket = this.socket;
    this.stopped = true;
    this.teardown();
    this.rejectWaiters(status);
    this.deps.onStatus(status, detail);
    socket?.close(1000);
  }

  private rejectWaiters(code: string): void {
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new RelayCommandError(code));
  }

  private retryProof(date: string | undefined): boolean {
    if (this.proofRetried) return false;
    this.proofRetried = true;
    const relayTime = date ? Date.parse(date) : Number.NaN;
    if (Number.isFinite(relayTime)) this.clockSkewS = Math.round((relayTime - Date.now()) / 1000);
    return true;
  }

  private killSwitch(): void {
    const random = this.deps.random ?? Math.random;
    this.deps.onStatus('disabled');
    this.schedule(KILL_SWITCH_MIN_MS + random() * (KILL_SWITCH_MAX_MS - KILL_SWITCH_MIN_MS));
  }

  private after(status: RelayStatus, seconds: number | undefined): void {
    this.deps.onStatus(status);
    if (seconds !== undefined) this.schedule(seconds * 1000);
    else this.backoff();
  }

  private onRefused(refusal: SocketRefusal): void {
    this.teardown();
    switch (refusal.status) {
      case 401:
        if (this.retryProof(refusal.date)) this.schedule(0);
        else this.halt('error', 'the relay refused this computer’s proof');
        return;
      case 426: this.halt('update-required'); return;
      case 429: this.after('rate-limited', refusal.retryAfter); return;
      case 503: this.killSwitch(); return;
      default:
        if (refusal.status >= 500 || refusal.status === 0) {
          this.deps.onStatus('unreachable');
          this.rejectWaiters('unreachable');
          this.backoff();
          return;
        }
        this.halt('error', `the relay refused the connection (${refusal.code ?? refusal.status})`);
    }
  }

  private onClose(code: number): void {
    const retryAfter = this.retryAfterS;
    this.retryAfterS = undefined;
    this.teardown();
    if (this.stopped) return;
    switch (code) {
      case 4409: this.halt('replaced'); return;
      case 4400:
      case 4413: this.halt('error', `the relay closed with ${code}`); return;
      case 4401:
        if (this.retryProof(undefined)) this.schedule(0);
        else this.halt('error', 'the relay refused this computer’s proof');
        return;
      case 4426: this.halt('update-required'); return;
      case 4429: this.after('rate-limited', retryAfter); return;
      case 4430: this.after('quota', retryAfter); return;
      case 4503: this.killSwitch(); return;
      default:
        this.deps.onStatus('unreachable');
        this.backoff();
    }
  }
}

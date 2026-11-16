import { randomUUID } from 'node:crypto';
import type { RelayDiagnostics, RelayStatus } from '@open-mercato/cezar-contract';
import type { RelayIdentity } from './identity.ts';
import type { RelaySocket, SocketFactory, SocketRefusal } from './socket.ts';
import { LIMIT_DEFAULTS, RELAY_PROTOCOL_VERSION, RENDEZVOUS_FRAME_BYTES, b64u, fromB64u, proofHeaders, socketOrigin, socketProof } from './wire.ts';

export const PING_MS = 45_000;
export const PONG_WAIT_MS = 15_000;
export const COMMAND_TIMEOUT_MS = 10_000;
const RESET_ATTEMPTS_AFTER_MS = 60_000;
const MAX_BACKOFF_S = 300;
/** The relay's `retryAfter` is unchecked input: past 2^31 ms a timer fires at once. */
const MAX_RETRY_AFTER_S = 86_400;
const KILL_SWITCH_MIN_MS = 5 * 60_000;
const KILL_SWITCH_MAX_MS = 15 * 60_000;
/** After a 4451, § 18: a fixed 10 minutes plus up to 60 s of jitter, never longer, and at once after a confirmation. */
export const ACCOUNT_RETRY_MS = 10 * 60_000;
export const ACCOUNT_RETRY_JITTER_MS = 60_000;
/** After a 4451 `suspended`: only the relay operator lifts it, so once an hour at most, § 18. */
export const SUSPENDED_RETRY_MS = 60 * 60_000;
/** A socket with no `hello` by then is stuck before it was ever live, so nothing else would notice. */
export const HELLO_WAIT_MS = 30_000;
/** 1012 `reconnect`: the relay operator asked for a fresh socket (rome #13), so come back within seconds. */
export const SERVICE_RESTART_MIN_MS = 1_000;
export const SERVICE_RESTART_JITTER_MS = 4_000;
/** Timers freeze while the computer sleeps and the wall clock does not, so a gap this wide is a wake. */
export const WAKE_TICK_MS = 10_000;
const WAKE_GAP_MS = 30_000;
/** After a 4409: retry later, doubling to an hour, so a process that took over and then exited is not the end. */
export const REPLACED_RETRY_MS = 10 * 60_000;
const REPLACED_RETRY_MAX_MS = 60 * 60_000;
/** Half the relay's 60 commands a minute, so a reconnect loop can never reach its 4429. */
const COMMANDS_PER_MINUTE = 30;
/**
 * The relay counts both directions per room, and past `framesPerSecond` it closes cezar and drops
 * every phone. A first load is small responses, so HEAD and END take slots too, and the phone's
 * OPEN, END and WINDOW, which follow what cezar sends, stay within the share left over.
 */
const SEND_SHARE_OF_FRAMES = 0.4;

export interface RelayLimits {
  frameBytes: number;
  controlBytes: number;
  devices: number;
  framesPerSecond: number;
}

/** `hello` limits override the table; an absent key falls back to it (§ 4, § 8). */
export function limitsFrom(hello: { limits?: unknown }): RelayLimits {
  const live = (hello.limits && typeof hello.limits === 'object' ? hello.limits : {}) as Record<string, unknown>;
  const pick = (name: keyof RelayLimits): number => {
    const value = live[name];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : LIMIT_DEFAULTS[name];
  };
  return { frameBytes: pick('frameBytes'), controlBytes: pick('controlBytes'), devices: pick('devices'), framesPerSecond: pick('framesPerSecond') };
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
  now?: () => number;
  /** Every saved device, for the one `device-sync` after connecting. */
  syncDevices(): { device: string; key: string }[];
  onUp(phones: string[]): void;
  onDown(): void;
  onPhoneJoined(deviceId: string): void;
  onPhoneLeft(deviceId: string): void;
  onData(deviceId: string, ciphertext: Buffer): void;
  onStatus(status: RelayStatus, detail?: string): void;
  /** The relay account token for `X-Cezar-Relay-Account`, § 18. Optional on the wire. */
  accountToken?(): string | undefined;
  /** 401 `bad-token`: the token names an attachment that is gone. Drop it; the upgrade goes again without. */
  onBadToken?(): void;
  /** One diagnostic line per transition: reasons, codes, timings and counts only, never an id or key. */
  log?(line: string): void;
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
  /** The `error` code a refused socket sends before its 4451, § 18. */
  private closeReason: string | undefined;
  /** Until when a `suspended` refusal holds every reconnect, `retryNow` included. */
  private suspendedUntil = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** The pending reconnect is a network-loss backoff, which a wake may cut short; a relay-imposed wait is not. */
  private backingOff = false;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private helloTimer: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private lastTickAt = 0;
  private lastPingAt = 0;
  private replacements = 0;
  /** For Settings and the sidebar dot: what happened last, kept across reconnects. */
  private nextRetryAt = 0;
  private lastDown: { at: number; reason: string; code?: number } | undefined;
  private lastBlock: { at: number; reason: string } | undefined;
  /** The popover's quick stats: since the first `start`, in memory only. */
  private trackedFrom = 0;
  private upMs = 0;
  private upSince = 0;
  private relayed = { day: '', count: 0 };
  private readonly commands = new Map<string, PendingCommand>();
  private commandTimes: number[] = [];
  private nextFrameAt = 0;
  private readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  limits: RelayLimits = { ...LIMIT_DEFAULTS };

  constructor(private readonly deps: RelayConnectionDeps) {}

  get ready(): boolean {
    return this.live;
  }

  /** In-process state only, never a call to the relay. */
  diagnostics(): RelayDiagnostics {
    const iso = (at: number) => new Date(at).toISOString();
    return {
      ...(this.live && this.connectedAt ? { connectedAt: iso(this.connectedAt) } : {}),
      ...(this.attempts > 0 ? { attempt: this.attempts } : {}),
      ...(this.reconnectTimer && this.nextRetryAt ? { nextRetryAt: iso(this.nextRetryAt) } : {}),
      ...(this.lastDown ? { lastDown: { at: iso(this.lastDown.at), reason: this.lastDown.reason, ...(this.lastDown.code !== undefined ? { code: this.lastDown.code } : {}) } } : {}),
      ...(this.lastBlock ? { lastBlock: { at: iso(this.lastBlock.at), reason: this.lastBlock.reason } } : {}),
      ...(this.trackedFrom ? { stats: this.stats() } : {}),
    };
  }

  private stats(): NonNullable<RelayDiagnostics['stats']> {
    const now = this.now();
    const span = now - this.trackedFrom;
    const up = this.upMs + (this.upSince ? now - this.upSince : 0);
    return {
      since: new Date(this.trackedFrom).toISOString(),
      relayedToday: this.relayed.day === localDay(now) ? this.relayed.count : 0,
      uptime: span > 0 ? Math.min(1, up / span) : (this.upSince ? 1 : 0),
    };
  }

  private countFrame(): void {
    const day = localDay(this.now());
    this.relayed = this.relayed.day === day ? { day, count: this.relayed.count + 1 } : { day, count: 1 };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private noteDown(reason: string, code?: number): void {
    this.lastDown = { at: (this.deps.now ?? Date.now)(), reason: reasonCode(reason), ...(code !== undefined ? { code } : {}) };
  }

  start(): void {
    this.stopped = false;
    if (!this.trackedFrom) this.trackedFrom = this.now();
    this.armWake();
    if (!this.socket && !this.reconnectTimer) this.connect();
  }

  /** An account was attached or confirmed: try now instead of at the next 4451 retry. `lifted`: the relay's status says a suspension ended. */
  retryNow(lifted = false): void {
    if (this.stopped || this.socket) return;
    if (!lifted && (this.deps.now ?? Date.now)() < this.suspendedUntil) return;
    this.suspendedUntil = 0;
    this.clearReconnect();
    this.connect();
  }

  /** Closes for good. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.disarmWake();
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
    const now = Date.now();
    this.commandTimes = this.commandTimes.filter((at) => now - at < 60_000);
    if (this.commandTimes.length >= COMMANDS_PER_MINUTE) {
      const waitMs = this.commandTimes[0]! + 60_000 - now;
      return new Promise((resolve) => { setTimeout(resolve, waitMs).unref?.(); }).then(() => this.command(frame, timeoutMs));
    }
    this.commandTimes.push(now);
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

  /** Resolves when one more tunnel frame fits the pace. Bytes that wait here coalesce, § 12.2. */
  frameSlot(): Promise<void> {
    const spacingMs = 1000 / Math.max(1, this.limits.framesPerSecond * SEND_SHARE_OF_FRAMES);
    const now = Date.now();
    const at = Math.max(now, this.nextFrameAt);
    this.nextFrameAt = at + spacingMs;
    return new Promise((resolve) => { setTimeout(resolve, at - now); });
  }

  /** Only a session calls this, which is what keeps § 6 rule 5 true. */
  sendData(deviceId: string, ciphertext: Buffer): void {
    if (!this.live || !this.socket) return;
    this.countFrame();
    this.socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(deviceId, 'base64url'), ciphertext]));
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
      { ...proofHeaders(identity.edSeed, proof, time), ...accountHeader(this.deps.accountToken?.()) },
      {
        onOpen: () => {},
        onMessage: (data) => own(() => this.onMessage(data)),
        onClose: (code, reason) => own(() => this.onClose(code, reason)),
        onRefused: (refusal) => own(() => this.onRefused(refusal)),
      },
    );
    this.socket = socket;
    this.helloTimer = setTimeout(() => own(() => this.lose('no-hello')), HELLO_WAIT_MS);
    this.helloTimer.unref?.();
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
      case 'error':
        if (frame.id === undefined && typeof frame.code === 'string') this.closeReason = frame.code;
        else this.settle(frame.id, typeof frame.code === 'string' ? frame.code : 'internal');
        break;
      case 'closing': if (typeof frame.retryAfter === 'number') this.retryAfterS = frame.retryAfter; break;
      default: break; // Unknown `t` values are ignored, § 4.
    }
  }

  private onBinary(data: Buffer): void {
    if (!this.live || data.length < 17 || data[0] !== 1) return;
    this.countFrame();
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
    this.clearHello();
    this.connectedAt = Date.now();
    this.upSince = this.now();
    this.log(`connected attempt=${this.attempts}`);
    this.deps.onStatus('connected');
    this.armPing();
    const phones = Array.isArray(frame.phones) ? frame.phones.filter((id): id is string => typeof id === 'string' && fromB64u(id, 16) !== null) : [];
    this.deps.onUp(phones);
    void this.sync();
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
  }

  /**
   * § 18: a `device-sync` that adds a device is refused as a whole without an account. `device-add`
   * of a device the relay already holds is accepted, so that sorts the list; the rest syncs without the new ones.
   */
  private async sync(): Promise<void> {
    const devices = this.deps.syncDevices();
    try {
      await this.command({ t: 'device-sync', devices });
      return;
    } catch (error) {
      if (!(error instanceof RelayCommandError && error.code === 'terms-required')) return;
    }
    const known: typeof devices = [];
    for (const device of devices) {
      try {
        await this.command({ t: 'device-add', device: device.device, key: device.key });
        known.push(device);
      } catch {
        // Not on the relay's list, and it takes no new device until an account is attached.
      }
    }
    await this.command({ t: 'device-sync', devices: known }).catch(() => {});
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
    this.pingTimer = setInterval(() => this.probe(), PING_MS);
    this.pingTimer.unref?.();
  }

  /** One `ping`; no `pong` in 15 s is network loss, handled here rather than trusting a `close` to follow. */
  private probe(): void {
    this.lastPingAt = Date.now();
    this.socket?.send('ping');
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      this.lose('no-pong');
    }, PONG_WAIT_MS);
    this.pongTimer.unref?.();
  }

  /** The socket is dead without having said so: drop it now and reconnect. Its late `close` is ignored. */
  private lose(reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.noteDown(reason);
    this.teardown();
    this.reconnectAfterLoss(reason);
    socket.terminate();
  }

  private reconnectAfterLoss(reason: string, code?: number): void {
    const upS = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0;
    const delayMs = this.backoff();
    const retryS = Math.round(delayMs / 1000);
    this.log(`down reason=${reason}${code !== undefined ? ` code=${code}` : ''} up=${upS}s attempt=${this.attempts} retry=${retryS}s`);
    this.deps.onStatus('unreachable', `lost the relay (${reason}${code !== undefined ? ` ${code}` : ''}); attempt ${this.attempts}, next try in ${retryS} s`);
  }

  private armWake(): void {
    if (this.wakeTimer) return;
    this.lastTickAt = Date.now();
    this.wakeTimer = setInterval(() => this.wakeTick(), WAKE_TICK_MS);
    this.wakeTimer.unref?.();
  }

  private disarmWake(): void {
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  /** After a sleep the socket is likely dead and a backoff may be minutes out: check now, retry now. */
  private wakeTick(): void {
    const now = Date.now();
    const gapMs = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gapMs < WAKE_TICK_MS + WAKE_GAP_MS) return;
    this.log(`wake gap=${Math.round(gapMs / 1000)}s live=${this.live} backoff=${this.backingOff}`);
    if (this.live) {
      if (now - this.lastPingAt >= 20_000) this.probe(); // § 4: never more than one ping per 20 s.
    } else if (this.reconnectTimer && this.backingOff) {
      this.attempts = 0;
      this.clearReconnect();
      this.connect();
    }
  }

  private clearHello(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
  }

  private log(line: string): void {
    (this.deps.log ?? ((text: string) => console.warn(text)))(`[cezar] relay: ${line}`);
  }

  private teardown(): void {
    const wasLive = this.live;
    this.live = false;
    if (this.upSince) this.upMs += this.now() - this.upSince;
    this.upSince = 0;
    this.socket = undefined;
    this.clearHello();
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
    this.backingOff = false;
  }

  private schedule(delayMs: number, backingOff = false): void {
    if (this.stopped) return;
    this.clearReconnect();
    this.backingOff = backingOff;
    this.nextRetryAt = (this.deps.now ?? Date.now)() + delayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.backingOff = false;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /** A socket that stayed up long enough clears the failure history, whichever way it then ended. */
  private endUptime(): void {
    if (this.connectedAt && Date.now() - this.connectedAt >= RESET_ATTEMPTS_AFTER_MS) this.attempts = 0;
    if (this.connectedAt && Date.now() - this.connectedAt >= REPLACED_RETRY_MAX_MS) this.replacements = 0;
    this.connectedAt = 0;
  }

  private backoff(): number {
    this.endUptime();
    this.attempts += 1;
    const delayMs = backoffMs(this.attempts, this.deps.random ?? Math.random);
    this.schedule(delayMs, true);
    return delayMs;
  }

  /**
   * § 3.3 says another process owns this identity. If it has since exited, never coming back would
   * leave the phones with nobody, so look again later, slower each time it happens.
   */
  private replaced(): void {
    this.endUptime();
    this.replacements += 1;
    const delayMs = Math.min(REPLACED_RETRY_MAX_MS, REPLACED_RETRY_MS * 2 ** (this.replacements - 1))
      + (this.deps.random ?? Math.random)() * ACCOUNT_RETRY_JITTER_MS;
    this.rejectWaiters('replaced');
    this.log(`replaced code=4409 count=${this.replacements} retry=${Math.round(delayMs / 1000)}s`);
    this.deps.onStatus('replaced', 'another cezar process connected with this computer’s keys');
    this.schedule(delayMs);
  }

  /** Not a failure: no attempt counted, no growing backoff, `connecting` rather than `unreachable`. */
  private restartRequested(): void {
    this.endUptime();
    const delayMs = SERVICE_RESTART_MIN_MS + (this.deps.random ?? Math.random)() * SERVICE_RESTART_JITTER_MS;
    this.log(`restart code=1012 retry=${Math.round(delayMs / 1000)}s`);
    this.deps.onStatus('connecting');
    this.schedule(delayMs);
  }

  /** Stop reconnecting and say why; only a new start clears it. */
  private halt(status: RelayStatus, detail?: string): void {
    const socket = this.socket;
    this.stopped = true;
    this.disarmWake();
    this.log(`stopped status=${status}`);
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
    const delayMs = KILL_SWITCH_MIN_MS + random() * (KILL_SWITCH_MAX_MS - KILL_SWITCH_MIN_MS);
    this.log(`disabled retry=${Math.round(delayMs / 1000)}s`);
    this.deps.onStatus('disabled');
    this.schedule(delayMs);
  }

  private after(status: RelayStatus, seconds: number | undefined): void {
    this.deps.onStatus(status);
    if (seconds === undefined) {
      this.log(`${status} attempt=${this.attempts + 1}`);
      this.backoff();
      return;
    }
    const delayS = Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_S);
    this.log(`${status} retry=${delayS}s`);
    this.schedule(delayS * 1000);
  }

  private onRefused(refusal: SocketRefusal): void {
    this.noteDown(refusal.code ?? 'refused', refusal.status);
    this.teardown();
    // No relay `code` means something in between answered: a captive portal, a proxy, the CDN. That is
    // network loss, never a reason to stop for good or to wait out the kill switch.
    if (refusal.code === undefined && refusal.status !== 426 && refusal.status !== 429) {
      this.rejectWaiters('unreachable');
      this.reconnectAfterLoss('refused', refusal.status);
      return;
    }
    switch (refusal.status) {
      case 401:
        if (refusal.code === 'bad-token' && this.deps.accountToken?.()) {
          this.deps.onBadToken?.();
          if (!this.deps.accountToken?.()) {
            this.schedule(0);
            return;
          }
          this.halt('error', 'the relay refused this computer’s account token');
          return;
        }
        if (this.retryProof(refusal.date)) this.schedule(0);
        else this.halt('error', 'the relay refused this computer’s proof');
        return;
      case 426: this.halt('update-required'); return;
      case 429: this.after('rate-limited', refusal.retryAfter); return;
      default:
        if (refusal.status === 503 && refusal.code === 'relay-disabled') {
          this.killSwitch();
          return;
        }
        if (refusal.status >= 500 || refusal.status === 0) {
          this.rejectWaiters('unreachable');
          this.reconnectAfterLoss('refused', refusal.status);
          return;
        }
        this.halt('error', `the relay refused the connection (${refusal.code ?? refusal.status})`);
    }
  }

  private onClose(code: number, closeText?: string): void {
    const retryAfter = this.retryAfterS;
    // § 18: the `error` frame's reason, else the close frame's; neither means `email-unconfirmed`.
    const reason = this.closeReason ?? closeText;
    this.retryAfterS = undefined;
    this.closeReason = undefined;
    if (!this.stopped) this.noteDown(reason || 'closed', code);
    this.teardown();
    if (this.stopped) return;
    switch (code) {
      case 1012: this.restartRequested(); return;
      case 4409: this.replaced(); return;
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
      case 4451:
        this.lastBlock = { at: (this.deps.now ?? Date.now)(), reason: reasonCode(reason || 'email-unconfirmed') };
        if (reason === 'suspended') {
          this.log('blocked code=4451 reason=suspended');
          this.rejectWaiters('suspended');
          this.deps.onStatus('suspended');
          this.suspendedUntil = (this.deps.now ?? Date.now)() + SUSPENDED_RETRY_MS;
          this.schedule(SUSPENDED_RETRY_MS);
          return;
        }
        this.log(`blocked code=4451 reason=${reason === 'account-required' ? 'account-required' : 'email-unconfirmed'}`);
        this.rejectWaiters(reason ?? 'email-unconfirmed');
        this.deps.onStatus(reason === 'account-required' ? 'account-required' : 'email-unconfirmed');
        this.schedule(ACCOUNT_RETRY_MS + (this.deps.random ?? Math.random)() * ACCOUNT_RETRY_JITTER_MS);
        return;
      default:
        this.reconnectAfterLoss('closed', code);
    }
  }
}

/** A relay-sent reason is unchecked input: keep a short code, never free text. */
const reasonCode = (reason: string): string => (/^[a-z0-9-]{1,40}$/.test(reason) ? reason : 'other');

const accountHeader = (token: string | undefined): Record<string, string> => (token ? { 'X-Cezar-Relay-Account': token } : {});

/** "Today" is the user's own calendar day, as the popover shows it. */
const localDay = (at: number): string => new Date(at).toDateString();

import { randomBytes, randomUUID } from 'node:crypto';
import type { PhonePairing, PhonePairingFailure, PhonePairingStatus } from '@open-mercato/cezar-contract';
import type { RelayIdentity } from './identity.ts';
import { RendezvousChannel, RendezvousRefused, type ChannelEnd, type PairedPhone } from './rendezvous.ts';
import type { SocketFactory } from './socket.ts';
import { deriveFromCode, deriveFromSecret, displayCode, generateCode, qrString } from './wire.ts';

/** The 2-minute QR life and claim window, § 15. */
export const PAIRING_LIFE_MS = 120_000;
/** Counted from the rendezvous' creation, so the phone hears `timeout` rather than a 4408, § 9.4. */
export const PAIRING_DECISION_LIMIT_MS = 285_000;
export const PAIRING_CLOSE_AFTER_OUTCOME_MS = 5_000;

export interface PairingCredentials {
  id: string;
  qr: string;
  expiresAt: string;
}

export class PairingStartError extends Error {
  constructor(message: string, readonly retryAfter?: number) {
    super(message);
  }
}

export interface PairingDeps {
  origin: string;
  identity: RelayIdentity;
  label: string;
  open: SocketFactory;
  onChange(): void;
  /** False refuses the phone with `bad-payload`, before the user is asked anything. */
  accepts(phone: PairedPhone): boolean;
  /** Saves the device, reaches the relay, sends `device-add`. Throws a failure reason. */
  commit(phone: PairedPhone): Promise<void>;
  rollback(phone: PairedPhone): void;
}

/** One pairing: both rendezvous, the handshake on whichever a phone joined, the decision. */
export class Pairing {
  readonly id = randomUUID();
  private status: PhonePairingStatus = 'waiting';
  private failure: PhonePairingFailure | undefined;
  private channels: RendezvousChannel[] = [];
  private winner: RendezvousChannel | undefined;
  private phone: PairedPhone | undefined;
  private digits: string | undefined;
  private expiresAtMs = 0;
  private lifeTimer: NodeJS.Timeout | undefined;
  private decisionTimer: NodeJS.Timeout | undefined;
  private closeTimer: NodeJS.Timeout | undefined;
  private settled = false;
  private code: string | undefined;

  constructor(private readonly deps: PairingDeps) {}

  /** Opens the QR's rendezvous. The secret lives in this frame and the response, nowhere else. */
  async start(): Promise<PairingCredentials> {
    const { origin, identity } = this.deps;
    const secret = randomBytes(32);
    const qr = this.channel('qr', deriveFromSecret(secret));
    this.channels = [qr];
    try {
      await qr.open();
    } catch (error) {
      this.closeChannels();
      throw refusalError(error);
    }
    this.expiresAtMs = Date.now() + PAIRING_LIFE_MS;
    this.lifeTimer = setTimeout(() => this.expire(), PAIRING_LIFE_MS);
    this.lifeTimer.unref?.();
    return { id: this.id, qr: qrString(origin, secret, identity.x25519Public), expiresAt: new Date(this.expiresAtMs).toISOString() };
  }

  /** The typed code's own rendezvous, on request. If it is refused, the QR code stands alone. */
  async revealCode(): Promise<string> {
    if (this.code) return this.code;
    if (this.settled || this.winner) throw new PairingStartError('This pairing can no longer use a typed code.');
    const code = generateCode();
    const channel = this.channel('code', await deriveFromCode(code));
    this.channels.push(channel);
    try {
      await channel.open();
    } catch (error) {
      this.channels = this.channels.filter((item) => item !== channel);
      channel.close();
      throw refusalError(error);
    }
    if (this.settled || this.winner) {
      channel.close();
      throw new PairingStartError('This pairing can no longer use a typed code.');
    }
    this.code = displayCode(code);
    return this.code;
  }

  private channel(kind: 'qr' | 'code', keys: Awaited<ReturnType<typeof deriveFromCode>>): RendezvousChannel {
    return new RendezvousChannel(kind, keys, {
      origin: this.deps.origin,
      identity: this.deps.identity,
      label: this.deps.label,
      open: this.deps.open,
      accepts: (phone) => this.deps.accepts(phone),
      events: {
        onPeerJoined: (channel) => this.onPeerJoined(channel),
        onPhone: (channel, phone, digits) => this.onPhone(channel, phone, digits),
        onEnd: (channel, end) => this.onChannelEnd(channel, end),
      },
    });
  }

  private onPeerJoined(channel: RendezvousChannel): void {
    if (this.settled || this.winner) {
      channel.close();
      return;
    }
    this.winner = channel;
    if (this.lifeTimer) clearTimeout(this.lifeTimer);
    this.lifeTimer = undefined;
    for (const other of this.channels) if (other !== channel) other.close();
    this.channels = [channel];
    this.decisionTimer = setTimeout(() => this.fail('timeout'), channel.openedAt + PAIRING_DECISION_LIMIT_MS - Date.now());
    this.decisionTimer.unref?.();
    this.set('handshaking');
  }

  private onPhone(channel: RendezvousChannel, phone: PairedPhone, digits: string): void {
    if (channel !== this.winner || this.settled) return;
    this.phone = phone;
    this.digits = digits;
    this.set('confirm');
  }

  private onChannelEnd(channel: RendezvousChannel, end: ChannelEnd): void {
    if (this.settled) return;
    if (channel !== this.winner) {
      this.channels = this.channels.filter((item) => item !== channel);
      if (!this.winner && this.channels.length === 0) this.finish('expired');
      return;
    }
    if (this.status === 'approving') return; // `approve` sees the dead channel and rolls back.
    if (end.kind === 'contested') this.fail('contested');
    else if (end.kind === 'failed' && end.reason !== 'handshake') this.finish('failed', end.reason);
    else this.finish('failed', 'phone-left');
  }

  private expire(): void {
    if (!this.settled) this.finish('expired');
  }

  private set(status: PhonePairingStatus): void {
    this.status = status;
    this.deps.onChange();
  }

  private clearTimers(): void {
    if (this.lifeTimer) clearTimeout(this.lifeTimer);
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    this.lifeTimer = undefined;
    this.decisionTimer = undefined;
  }

  private closeChannels(): void {
    for (const channel of this.channels) channel.close();
  }

  private finish(status: PhonePairingStatus, failure?: PhonePairingFailure): void {
    if (this.settled) return;
    this.settled = true;
    this.failure = failure;
    this.clearTimers();
    this.closeChannels();
    this.set(status);
  }

  /** The phone closes after an outcome; cezar does after 5 s if it has not. */
  private outcome(status: PhonePairingStatus, failure?: PhonePairingFailure): void {
    this.settled = true;
    this.failure = failure;
    this.clearTimers();
    this.closeTimer = setTimeout(() => this.closeChannels(), PAIRING_CLOSE_AFTER_OUTCOME_MS);
    this.closeTimer.unref?.();
    this.set(status);
  }

  private fail(reason: PhonePairingFailure): void {
    if (this.settled) return;
    this.winner?.tell({ t: 'failure', reason });
    this.outcome('failed', reason);
  }

  get canReplace(): boolean {
    return this.settled || this.status === 'waiting';
  }

  /** The user asked for a new code or left the screen. */
  cancel(): void {
    // An approval in flight stands: `commit` tells the phone, and a second answer would contradict it.
    if (this.settled || this.status === 'approving') return;
    if (this.winner) {
      this.winner.tell({ t: 'failure', reason: 'cancelled' });
      this.outcome('cancelled');
    } else {
      this.finish('cancelled');
    }
  }

  deny(): boolean {
    if (this.settled || this.status !== 'confirm') return false;
    this.winner?.tell({ t: 'denied' });
    this.outcome('denied');
    return true;
  }

  approve(): boolean {
    if (this.settled || this.status !== 'confirm' || !this.phone) return false;
    this.clearTimers(); // The user answered, so `timeout` can no longer be the outcome.
    this.set('approving');
    void this.commit(this.phone);
    return true;
  }

  private async commit(phone: PairedPhone): Promise<void> {
    try {
      await this.deps.commit(phone);
    } catch (error) {
      this.deps.rollback(phone);
      const reason = (error instanceof Error ? error.message : '') === 'device-limit' ? 'device-limit' : 'relay-error';
      this.winner?.tell({ t: 'failure', reason });
      this.outcome('failed', reason);
      return;
    }
    // The phone never heard `approved`, so it does not believe it paired: leave no row behind.
    if (!this.winner?.alive) {
      this.deps.rollback(phone);
      this.finish('failed', 'phone-left');
      return;
    }
    this.winner.tell({ t: 'approved' });
    this.outcome('approved');
  }

  /** What Settings may see. Never the secret, the code or the QR string. */
  view(): PhonePairing {
    return {
      id: this.id,
      status: this.status,
      expiresAt: new Date(this.expiresAtMs).toISOString(),
      ...(this.winner ? { method: this.winner.kind } : {}),
      ...(this.phone ? { phone: { name: this.phone.name, platform: this.phone.platform } } : {}),
      ...(this.digits ? { digits: this.digits } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  dispose(): void {
    this.settled = true;
    this.clearTimers();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeChannels();
  }
}

function refusalError(error: unknown): PairingStartError {
  if (error instanceof RendezvousRefused) {
    const { status, retryAfter } = error.refusal;
    if (status === 429) return new PairingStartError('The relay limits how often a code can be shown. Try again later.', retryAfter);
    if (status === 503) return new PairingStartError('The relay is switched off for now. Try again later.', retryAfter);
    if (status === 426) return new PairingStartError('This cezar is too old for the relay. Update cezar.');
  }
  return new PairingStartError('Could not reach the relay.');
}

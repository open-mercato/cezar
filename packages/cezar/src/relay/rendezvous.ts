import { z } from 'zod';
import type { RelayIdentity } from './identity.ts';
import { CipherState, HandshakeState } from './noise.ts';
import type { RelaySocket, SocketFactory, SocketRefusal } from './socket.ts';
import { PING_MS } from './connection.ts';
import { TUNNEL_RANGE, b64u, decodeRecord, encodeRecord, fromB64u, pairPrologue, proofHeaders, relayId, sas, socketOrigin, socketProof, type PairingKeys } from './wire.ts';

const EMPTY = Buffer.alloc(0);
const HELLO_TIMEOUT_MS = 10_000;
export const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_PAIRING_JSON = 1_024;
const XX_FIRST_BYTES = 48;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const phoneHelloSchema = z.object({
  name: z.string().refine((name) => utf8Bytes(name) >= 1 && utf8Bytes(name) <= 64 && !CONTROL.test(name)),
  platform: z.enum(['android', 'ios']),
  relayKey: z.string().refine((key) => fromB64u(key, 32) !== null),
  tunnel: z.object({ min: z.number().int().min(0).max(65_535), max: z.number().int().min(0).max(65_535) }),
});

export interface PairedPhone {
  name: string;
  platform: 'android' | 'ios';
  relayKey: string;
  noiseKey: string;
  deviceId: string;
}

export type ChannelEnd =
  | { kind: 'failed'; reason: 'bad-payload' | 'tunnel-unsupported' | 'handshake' }
  | { kind: 'contested' }
  | { kind: 'peer-left' }
  | { kind: 'closed'; code: number };

export interface ChannelEvents {
  onPeerJoined(channel: RendezvousChannel): void;
  onPhone(channel: RendezvousChannel, phone: PairedPhone, digits: string): void;
  onEnd(channel: RendezvousChannel, end: ChannelEnd): void;
}

export type ChannelMessage =
  | { t: 'approved' }
  | { t: 'denied' }
  | { t: 'failure'; reason: string; tunnel?: { min: number; max: number } };

export class RendezvousRefused extends Error {
  constructor(readonly refusal: SocketRefusal) {
    super(refusal.code ?? String(refusal.status));
  }
}

/** One credential's rendezvous, § 5 and § 9.3. It is never reconnected: any end ends the code. */
export class RendezvousChannel {
  private socket: RelaySocket | undefined;
  private handshake: HandshakeState;
  private sender: CipherState | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private ended = false;
  private joined = false;
  private opened: { resolve(): void; reject(error: Error): void } | undefined;

  constructor(
    readonly kind: 'qr' | 'code',
    private readonly keys: PairingKeys,
    private readonly deps: { origin: string; identity: RelayIdentity; label: string; open: SocketFactory; events: ChannelEvents },
  ) {
    this.handshake = new HandshakeState({
      pattern: 'XXpsk3',
      initiator: false,
      prologue: pairPrologue(keys.locator),
      s: deps.identity.x25519Secret,
      psk: keys.psk,
    });
  }

  /** Resolves on `hello`. A refusal rejects with {@link RendezvousRefused}. */
  open(): Promise<void> {
    const { identity, origin, open } = this.deps;
    const locator = b64u(this.keys.locator);
    const time = Math.floor(Date.now() / 1000);
    const proof = socketProof('pair', locator, '-', time);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opened = undefined;
        reject(new RendezvousRefused({ status: 0 }));
        this.close();
      }, HELLO_TIMEOUT_MS);
      timer.unref?.();
      this.opened = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.socket = open(`${socketOrigin(origin)}/v1/pair/${locator}?role=cezar`, { ...proofHeaders(identity.edSeed, proof, time) }, {
        onOpen: () => {},
        onMessage: (data) => this.onMessage(data),
        onClose: (code) => this.finish({ kind: 'closed', code }),
        onRefused: (refusal) => {
          const opened = this.opened;
          this.opened = undefined;
          opened?.reject(new RendezvousRefused(refusal));
          this.finish({ kind: 'closed', code: refusal.status });
        },
      });
    });
  }

  private onMessage(data: string | Buffer): void {
    if (this.ended) return;
    if (typeof data !== 'string') {
      this.onBinary(data);
      return;
    }
    if (data === 'pong') return;
    let frame: { t?: unknown };
    try {
      frame = JSON.parse(data) as { t?: unknown };
    } catch {
      return;
    }
    switch (frame.t) {
      case 'hello': this.onHello(); break;
      case 'peer-joined': this.onPeerJoined(); break;
      case 'peer-left': this.finish({ kind: 'peer-left' }); break;
      case 'pair-contested': this.finish({ kind: 'contested' }); break;
      default: break;
    }
  }

  private onHello(): void {
    const opened = this.opened;
    this.opened = undefined;
    opened?.resolve();
    this.pingTimer = setInterval(() => this.socket?.send('ping'), PING_MS);
    this.pingTimer.unref?.();
  }

  private onPeerJoined(): void {
    if (this.joined) return;
    this.joined = true;
    this.handshakeTimer = setTimeout(() => this.finish({ kind: 'failed', reason: 'handshake' }), HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();
    this.deps.events.onPeerJoined(this);
  }

  private onBinary(frame: Buffer): void {
    if (!this.joined || frame[0] !== 1 || this.handshake.done) return;
    const message = frame.subarray(1);
    try {
      if (this.sender === undefined && this.turn === 0) this.onFirst(message);
      else this.onThird(message);
    } catch {
      this.finish({ kind: 'failed', reason: 'handshake' });
    }
  }

  private turn = 0;

  private onFirst(message: Buffer): void {
    if (message.length !== XX_FIRST_BYTES) throw new Error('first pairing message size');
    this.handshake.readMessage(message);
    // Nothing goes to an unproven peer: the payload stays empty, § 9.3.
    this.sendData(this.handshake.writeMessage(EMPTY));
    this.turn = 1;
  }

  private onThird(message: Buffer): void {
    const payload = this.handshake.readMessage(message);
    const { send } = this.handshake.split();
    this.sender = send;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const phone = this.parsePhone(payload);
    if (!phone) return;
    this.sendJson({ t: 'pending', relayKey: b64u(this.deps.identity.edPublic), tunnel: TUNNEL_RANGE, label: this.deps.label });
    this.deps.events.onPhone(this, phone, sas(this.handshake.h));
  }

  private parsePhone(payload: Buffer): PairedPhone | null {
    let parsed: z.infer<typeof phoneHelloSchema>;
    try {
      const content = decodeRecord(payload);
      if (content.length > MAX_PAIRING_JSON) throw new Error('too long');
      parsed = phoneHelloSchema.parse(JSON.parse(content.toString('utf8')));
    } catch {
      this.endWith({ t: 'failure', reason: 'bad-payload' }, { kind: 'failed', reason: 'bad-payload' });
      return null;
    }
    if (Math.min(parsed.tunnel.max, TUNNEL_RANGE.max) < Math.max(parsed.tunnel.min, TUNNEL_RANGE.min)) {
      this.endWith({ t: 'failure', reason: 'tunnel-unsupported', tunnel: TUNNEL_RANGE }, { kind: 'failed', reason: 'tunnel-unsupported' });
      return null;
    }
    return {
      name: parsed.name,
      platform: parsed.platform,
      relayKey: parsed.relayKey,
      noiseKey: b64u(this.handshake.rs!),
      deviceId: relayId(fromB64u(parsed.relayKey, 32)!),
    };
  }

  private endWith(message: ChannelMessage, end: ChannelEnd): void {
    this.sendJson(message);
    this.finish(end);
  }

  private sendData(ciphertext: Buffer): void {
    this.socket?.send(Buffer.concat([Buffer.from([1]), ciphertext]));
  }

  private sendJson(message: object): void {
    if (!this.sender) return;
    this.sendData(this.sender.encrypt(EMPTY, encodeRecord(Buffer.from(JSON.stringify(message), 'utf8'))));
  }

  /** An outcome after `pending`. The phone closes; `close` is the caller's 5 s backstop. */
  tell(message: ChannelMessage): void {
    if (!this.ended) this.sendJson(message);
  }

  get alive(): boolean {
    return !this.ended;
  }

  /** Closes with 1000 and reports nothing: the caller already decided. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.socket?.close(1000);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.pingTimer = undefined;
    this.handshakeTimer = undefined;
  }

  private finish(end: ChannelEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.socket?.close(1000);
    this.deps.events.onEnd(this, end);
  }
}

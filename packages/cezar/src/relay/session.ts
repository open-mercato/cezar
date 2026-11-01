import { CipherState, HandshakeState } from './noise.ts';
import {
  CLOSE,
  OpenRefused,
  RESET,
  TUNNEL_RANGE,
  decodeFrame,
  decodeRecord,
  encodeFrame,
  encodeRecord,
  sessionPrologue,
  sizes,
  type TunnelFrame,
} from './wire.ts';
import { TunnelStream, type StreamHost } from './dispatcher.ts';

export const LEASE_TIMEOUT_MS = 60_000;
export const REKEY_AFTER_MS = 60 * 60_000;
const REKEY_AFTER_MESSAGES = 2 ** 32;
export const MAX_STREAMS = 32;
const EMPTY = Buffer.alloc(0);
const KK_FIRST_BYTES = 48;

export interface SessionDeps {
  deviceId: string;
  /** Every byte a session emits leaves here, and only a live session calls it. */
  send(ciphertext: Buffer): void;
  frameBytes(): number;
  dataSlot(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  onEnd(reason: 'closed' | 'goodbye'): void;
}

type Phase = 'hello' | 'lease' | 'ready';

/** One Noise `KK` run on one phone socket, § 10. It never outlives that socket. */
export class PhoneSession implements StreamHost {
  private ended = false;
  private phase: Phase = 'hello';
  private highestStream = 0;
  private readonly streams = new Map<number, TunnelStream>();
  private leaseTimer: NodeJS.Timeout | undefined;
  private keyedAt = Date.now();
  private sentUnderKey = 0;

  private constructor(private readonly deps: SessionDeps, private readonly sender: CipherState, private readonly receiver: CipherState) {
    this.renewLease();
  }

  /**
   * The responder half. Returns `null`, having sent nothing, for anything but a valid 48-byte first
   * message, so nothing is acted on before both ephemerals are mixed (no 0-RTT).
   */
  static accept(
    first: Buffer,
    keys: { cezarId: string; x25519Secret: Buffer; deviceNoiseKey: Buffer },
    deps: SessionDeps,
  ): PhoneSession | null {
    if (first.length !== KK_FIRST_BYTES) return null;
    const handshake = new HandshakeState({
      pattern: 'KK',
      initiator: false,
      prologue: sessionPrologue(keys.cezarId, deps.deviceId),
      s: keys.x25519Secret,
      rs: keys.deviceNoiseKey,
    });
    try {
      handshake.readMessage(first);
    } catch {
      return null;
    }
    const reply = handshake.writeMessage(encodeRecord(Buffer.from(JSON.stringify({ tunnel: TUNNEL_RANGE }), 'utf8')));
    const { send, receive } = handshake.split();
    deps.send(reply);
    return new PhoneSession(deps, send, receive);
  }

  get live(): boolean {
    return !this.ended;
  }

  dataSlot(): Promise<void> {
    return this.deps.dataSlot();
  }

  /** The Largest `DATA` payload for this socket, § 8. */
  get maxData(): number {
    return sizes(this.deps.frameBytes()).maxData;
  }

  sendFrame(frame: TunnelFrame): void {
    if (this.ended) return;
    if (Date.now() - this.keyedAt >= REKEY_AFTER_MS || this.sentUnderKey >= REKEY_AFTER_MESSAGES) this.rekey();
    this.seal(frame);
  }

  private seal(frame: TunnelFrame): void {
    this.sentUnderKey += 1;
    this.deps.send(this.sender.encrypt(EMPTY, encodeRecord(encodeFrame(frame))));
  }

  /** Last frame under the old key, then the sending cipher moves on, § 12.4. */
  private rekey(): void {
    this.seal({ type: 'rekey' });
    this.sender.rekey();
    this.keyedAt = Date.now();
    this.sentUnderKey = 0;
  }

  receive(ciphertext: Buffer): void {
    if (this.ended) return;
    let frame: TunnelFrame;
    try {
      frame = decodeFrame(decodeRecord(this.receiver.decrypt(EMPTY, ciphertext)));
    } catch (error) {
      if (error instanceof OpenRefused) {
        this.refuseOpen(error);
        return;
      }
      this.fail();
      return;
    }
    try {
      this.handle(frame);
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    this.close(CLOSE.protocolError);
  }

  /** Sends `CLOSE` if it can, ends every stream, then goes silent, § 10.1. */
  close(code: number): void {
    if (this.ended) return;
    this.seal({ type: 'close', code });
    this.finish('closed');
  }

  /** The socket or the relay went away: there is nobody to tell. */
  drop(): void {
    this.finish('closed');
  }

  private finish(reason: 'closed' | 'goodbye'): void {
    if (this.ended) return;
    this.ended = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
    this.deps.onEnd(reason);
  }

  private renewLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => this.close(CLOSE.leaseExpired), LEASE_TIMEOUT_MS);
    this.leaseTimer.unref?.();
  }

  private negotiate(frame: { min: number; max: number }): void {
    if (Math.min(frame.max, TUNNEL_RANGE.max) < Math.max(frame.min, TUNNEL_RANGE.min)) {
      this.close(CLOSE.tunnelUnsupported);
      return;
    }
    this.phase = 'lease';
  }

  private handle(frame: TunnelFrame): void {
    if (frame.type === 'close') {
      this.finish(frame.code === CLOSE.goodbye ? 'goodbye' : 'closed');
      return;
    }
    if (frame.type === 'rekey') {
      this.receiver.rekey();
      return;
    }
    if (this.phase === 'hello') {
      if (frame.type !== 'hello') throw new Error('first frame must be HELLO');
      this.negotiate(frame);
      return;
    }
    if (this.phase === 'lease' && frame.type !== 'lease') throw new Error('second frame must be LEASE');
    switch (frame.type) {
      case 'lease':
        this.phase = 'ready';
        this.renewLease();
        this.sendFrame({ type: 'lease' });
        return;
      case 'open': this.open(frame); return;
      case 'data':
      case 'end':
      case 'reset':
      case 'window': this.forStream(frame); return;
      default: throw new Error('a frame this direction may not send');
    }
  }

  private claimStream(id: number): void {
    if (id !== this.highestStream + 1) throw new Error('stream ids go up by one');
    this.highestStream = id;
    if (id === 0xffffffff) throw new Error('stream ids ran out');
  }

  private refuseOpen(refused: OpenRefused): void {
    try {
      this.claimStream(refused.stream);
    } catch {
      this.fail();
      return;
    }
    this.sendFrame({ type: 'reset', stream: refused.stream, code: refused.code });
  }

  private open(frame: Extract<TunnelFrame, { type: 'open' }>): void {
    this.claimStream(frame.stream);
    if (this.streams.size >= MAX_STREAMS) {
      this.sendFrame({ type: 'reset', stream: frame.stream, code: RESET.tooManyStreams });
      return;
    }
    const stream = new TunnelStream(frame, this, this.deps.fetch);
    this.streams.set(frame.stream, stream);
    stream.start();
  }

  private forStream(frame: Extract<TunnelFrame, { type: 'data' | 'end' | 'reset' | 'window' }>): void {
    if (frame.stream > this.highestStream) throw new Error('frame for a stream nobody opened');
    const stream = this.streams.get(frame.stream);
    if (!stream) return; // Finished or reset: it crossed in flight, § 12.1.
    stream.receive(frame);
  }

  /** A stream settled, so its slot among the 32 is free. */
  streamDone(id: number): void {
    this.streams.delete(id);
  }
}

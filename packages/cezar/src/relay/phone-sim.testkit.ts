import { randomBytes } from 'node:crypto';
import { CipherState, HandshakeState, generateX25519 } from './noise.ts';
import type { RelaySocket, SocketFactory } from './socket.ts';
import {
  b64u,
  decodeFrame,
  decodeRecord,
  deriveFromCode,
  deriveFromSecret,
  edPublic,
  encodeFrame,
  encodeRecord,
  fromB64u,
  pairPrologue,
  proofHeaders,
  relayId,
  sessionPrologue,
  sas,
  sizes,
  socketOrigin,
  socketProof,
  type PairingKeys,
  type TunnelFrame,
  type TunnelHeaders,
} from './wire.ts';

/** A phone, in Node: the app client's wire behaviour, for tests and the real-relay run. */

const EMPTY = Buffer.alloc(0);
const WAIT_MS = 10_000;

export function parseQr(qr: string): { origin: string; secret: Buffer; key: Buffer } | { refused: string } {
  const match = /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::([1-9][0-9]{0,4}))?\/p#([0-9]+)\.([^.]*)\.([^.]*)$/.exec(qr);
  if (!match) return { refused: 'grammar' };
  const [, scheme, host, port, version, secretText, keyText] = match as unknown as [string, string, string, string | undefined, string, string, string];
  if (port && Number(port) > 65535) return { refused: 'grammar' };
  if (version !== '1') return { refused: 'version' };
  const secret = fromB64u(secretText, 32);
  const key = fromB64u(keyText, 32);
  if (!secret || !key) return { refused: 'grammar' };
  if (scheme === 'http' && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return { refused: 'cleartext' };
  return { origin: `${scheme}://${host}${port ? `:${port}` : ''}`, secret, key };
}

export const normalizeCode = (input: string): string | null => {
  const text = input.replace(/[ \-‐-―]/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase()).replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(text) ? text : null;
};

class Queue<T> {
  private items: T[] = [];
  private waiters: { resolve(item: T): void; reject(error: Error): void; timer: NodeJS.Timeout }[] = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  next(label: string, timeoutMs = WAIT_MS): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

export type SimEvent =
  | { kind: 'control'; frame: Record<string, unknown> }
  | { kind: 'data'; bytes: Buffer }
  | { kind: 'close'; code: number }
  | { kind: 'refused'; status: number; code?: string };

interface Pipe {
  socket: RelaySocket;
  events: Queue<SimEvent>;
}

function pipe(open: SocketFactory, url: string, headers: Record<string, string>): Pipe {
  const events = new Queue<SimEvent>();
  const socket = open(url, headers, {
    onOpen: () => {},
    onMessage: (data) => {
      if (typeof data !== 'string') events.push({ kind: 'data', bytes: data.subarray(1) });
      else if (data !== 'pong') events.push({ kind: 'control', frame: JSON.parse(data) as Record<string, unknown> });
    },
    onClose: (code) => events.push({ kind: 'close', code }),
    onRefused: (refusal) => events.push({ kind: 'refused', status: refusal.status, ...(refusal.code ? { code: refusal.code } : {}) }),
  });
  return { socket, events };
}

async function until(events: Queue<SimEvent>, label: string, match: (event: SimEvent) => boolean, timeoutMs?: number): Promise<SimEvent> {
  for (;;) {
    const event = await events.next(label, timeoutMs);
    if (match(event)) return event;
    if (event.kind === 'close' || event.kind === 'refused') throw new Error(`${label}: ${JSON.stringify(event)}`);
  }
}

const isControl = (name: string) => (event: SimEvent): boolean => event.kind === 'control' && event.frame.t === name;

export interface StreamResult {
  status: number;
  headers: TunnelHeaders;
  body: Buffer;
}

export interface OpenStream {
  id: number;
  head: Promise<{ status: number; headers: TunnelHeaders }>;
  /** Resolves with one DATA payload as text, or `null` once the stream ended. */
  next(timeoutMs?: number): Promise<string | null>;
  done: Promise<Buffer>;
  reset(): void;
}

export class PhoneSim {
  readonly edSeed = randomBytes(32);
  readonly x25519 = generateX25519();
  readonly relayKey = edPublic(this.edSeed);
  readonly deviceId = relayId(this.relayKey);
  cezarId = '';
  cezarNoiseKey: Buffer | undefined;
  origin = '';
  private pairPipe: Pipe | undefined;
  private receiver: CipherState | undefined;
  /** Pipe of the live session socket. */
  private phone: Pipe | undefined;
  private sender: CipherState | undefined;
  private inbound: CipherState | undefined;
  private nextStream = 1;
  private readonly streams = new Map<number, {
    onFrame(frame: TunnelFrame): void;
  }>();
  readonly tunnelFrames: TunnelFrame[] = [];
  leases = 0;
  closes: number[] = [];
  lastFirstMessage: Buffer | undefined;

  constructor(private readonly open: SocketFactory, private readonly identity = { name: 'Sim phone', platform: 'android' }) {}

  async pairWithQr(qr: string): Promise<{ digits: string; pending: Record<string, unknown> }> {
    const parsed = parseQr(qr);
    if ('refused' in parsed) throw new Error(`QR refused: ${parsed.refused}`);
    return this.handshake(parsed.origin, deriveFromSecret(parsed.secret), parsed.key);
  }

  async pairWithCode(origin: string, code: string): Promise<{ digits: string; pending: Record<string, unknown> }> {
    const normalized = normalizeCode(code);
    if (!normalized) throw new Error('code refused');
    return this.handshake(origin, await deriveFromCode(normalized));
  }

  private async handshake(origin: string, keys: PairingKeys, pin?: Buffer): Promise<{ digits: string; pending: Record<string, unknown> }> {
    this.origin = origin;
    const channel = pipe(this.open, `${socketOrigin(origin)}/v1/pair/${b64u(keys.locator)}?role=phone`, {});
    this.pairPipe = channel;
    await until(channel.events, 'hello', isControl('hello'));
    await until(channel.events, 'peer-joined', isControl('peer-joined'));
    const noise = new HandshakeState({ pattern: 'XXpsk3', initiator: true, prologue: pairPrologue(keys.locator), s: this.x25519.secret, psk: keys.psk });
    channel.socket.send(Buffer.concat([Buffer.from([1]), noise.writeMessage()]));
    const second = await until(channel.events, 'second message', (event) => event.kind === 'data');
    noise.readMessage((second as { bytes: Buffer }).bytes);
    if (pin && !noise.rs?.equals(pin)) {
      channel.socket.close(1000);
      throw new Error('pin mismatch');
    }
    const payload = JSON.stringify({ ...this.identity, relayKey: b64u(this.relayKey), tunnel: { min: 1, max: 1 } });
    channel.socket.send(Buffer.concat([Buffer.from([1]), noise.writeMessage(encodeRecord(Buffer.from(payload)))]));
    this.receiver = noise.split().receive;
    this.cezarNoiseKey = noise.rs ?? undefined;
    const pending = await this.pairMessage();
    if (pending.t !== 'pending') throw new Error(`expected pending, got ${JSON.stringify(pending)}`);
    this.cezarId = relayId(fromB64u(pending.relayKey as string, 32)!);
    return { digits: sas(noise.h), pending };
  }

  private async pairMessage(timeoutMs?: number): Promise<Record<string, unknown>> {
    const event = await until(this.pairPipe!.events, 'pairing message', (item) => item.kind === 'data', timeoutMs);
    const text = decodeRecord(this.receiver!.decrypt(EMPTY, (event as { bytes: Buffer }).bytes));
    return JSON.parse(text.toString('utf8')) as Record<string, unknown>;
  }

  /** `approved`, `denied` or `failure`; the phone then closes with 1000. */
  async outcome(timeoutMs?: number): Promise<Record<string, unknown>> {
    const message = await this.pairMessage(timeoutMs);
    this.pairPipe?.socket.close(1000);
    return message;
  }

  /** Opens the phone socket and runs `KK`. Throws when the socket is refused or nobody answers. */
  async connect(): Promise<void> {
    const time = Math.floor(Date.now() / 1000);
    const proof = socketProof('phone', this.cezarId, this.deviceId, time);
    const channel = pipe(this.open, `${socketOrigin(this.origin)}/v1/phone/${this.cezarId}/${this.deviceId}`, { ...proofHeaders(this.edSeed, proof, time) });
    this.phone = channel;
    const hello = await until(channel.events, 'hello', isControl('hello')) as { frame: Record<string, unknown> };
    if (hello.frame.cezar !== 'online') await until(channel.events, 'cezar-online', isControl('cezar-online'));
    await this.handshakeSession(channel);
    void this.pump(channel);
  }

  private async handshakeSession(channel: Pipe): Promise<void> {
    const noise = new HandshakeState({
      pattern: 'KK',
      initiator: true,
      prologue: sessionPrologue(this.cezarId, this.deviceId),
      s: this.x25519.secret,
      rs: this.cezarNoiseKey!,
    });
    this.lastFirstMessage = noise.writeMessage();
    channel.socket.send(Buffer.concat([Buffer.from([1]), this.lastFirstMessage]));
    const reply = await until(channel.events, 'KK reply', (event) => event.kind === 'data');
    const range = JSON.parse(decodeRecord(noise.readMessage((reply as { bytes: Buffer }).bytes)).toString('utf8')) as { tunnel: unknown };
    if (!range.tunnel) throw new Error('no tunnel range');
    const { send, receive } = noise.split();
    this.sender = send;
    this.inbound = receive;
    this.frame({ type: 'hello', min: 1, max: 1 });
    this.frame({ type: 'lease' });
  }

  private async pump(channel: Pipe): Promise<void> {
    for (;;) {
      let event: SimEvent;
      try {
        event = await channel.events.next('phone frames', 3_600_000);
      } catch {
        return;
      }
      if (event.kind === 'close') {
        this.closes.push(event.code);
        return;
      }
      if (event.kind === 'data') this.onFrame(decodeFrame(decodeRecord(this.inbound!.decrypt(EMPTY, event.bytes))));
    }
  }

  private onFrame(frame: TunnelFrame): void {
    this.tunnelFrames.push(frame);
    if (frame.type === 'lease') this.leases += 1;
    if (frame.type === 'rekey') this.inbound!.rekey();
    if ('stream' in frame) this.streams.get(frame.stream)?.onFrame(frame);
  }

  frame(frame: TunnelFrame): void {
    this.raw(this.sender!.encrypt(EMPTY, encodeRecord(encodeFrame(frame))));
  }

  /** Bytes straight onto the phone socket, for the tests that lie. */
  raw(ciphertext: Buffer): void {
    this.phone!.socket.send(Buffer.concat([Buffer.from([1]), ciphertext]));
  }

  lease(): void {
    this.frame({ type: 'lease' });
  }

  closeSocket(): void {
    this.phone?.socket.close(1000);
  }

  stream(method: string, target: string, headers: TunnelHeaders = [], body?: Buffer | string): OpenStream {
    const id = this.nextStream;
    this.nextStream += 1;
    this.frame({ type: 'open', stream: id, method, target, headers });
    const chunks: Buffer[] = [];
    const data = new Queue<string | null>();
    let resolveHead!: (head: { status: number; headers: TunnelHeaders }) => void;
    let rejectAll!: (error: Error) => void;
    let resolveDone!: (body: Buffer) => void;
    const head = new Promise<{ status: number; headers: TunnelHeaders }>((resolve, reject) => { resolveHead = resolve; rejectAll = reject; });
    const done = new Promise<Buffer>((resolve, reject) => {
      resolveDone = resolve;
      const previous = rejectAll;
      rejectAll = (error) => { previous(error); reject(error); };
    });
    done.catch(() => {});
    head.catch(() => {});
    let unacked = 0;
    this.streams.set(id, {
      onFrame: (frame) => {
        if (frame.type === 'head') resolveHead({ status: frame.status, headers: frame.headers });
        if (frame.type === 'data') {
          chunks.push(frame.data);
          data.push(frame.data.toString('utf8'));
          unacked += frame.data.length;
          if (unacked >= 65_536) {
            this.frame({ type: 'window', stream: id, increment: unacked });
            unacked = 0;
          }
        }
        if (frame.type === 'end') {
          data.push(null);
          resolveDone(Buffer.concat(chunks));
        }
        if (frame.type === 'reset') {
          data.push(null);
          rejectAll(new Error(`reset ${frame.code}`));
        }
      },
    });
    if (body !== undefined) {
      const bytes = Buffer.from(body);
      const max = sizes(65_552).maxData;
      for (let at = 0; at < bytes.length; at += max) this.frame({ type: 'data', stream: id, data: bytes.subarray(at, at + max) });
    }
    this.frame({ type: 'end', stream: id });
    return {
      id,
      head,
      next: (timeoutMs) => data.next('stream data', timeoutMs),
      done,
      reset: () => this.frame({ type: 'reset', stream: id, code: 1 }),
    };
  }

  async fetch(method: string, target: string, headers: TunnelHeaders = [], body?: Buffer | string): Promise<StreamResult> {
    const stream = this.stream(method, target, headers, body);
    const head = await stream.head;
    return { ...head, body: await stream.done };
  }
}


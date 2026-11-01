import { createHash, createPrivateKey, createPublicKey, hkdfSync, pbkdf2, randomInt, sign, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';

/** The relay wire formats, as RELAY_PROTOCOL.md defines them. No state lives here. */

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const pbkdf2Async = promisify(pbkdf2);

export const RELAY_PROTOCOL_VERSION = 1;
export const TUNNEL_RANGE = { min: 1, max: 1 } as const;

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** Strict decoder: refuses padding, the `+/` alphabet and non-canonical trailing bits (§ 2). */
export function fromB64u(text: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const out = Buffer.from(text, 'base64url');
  return out.length === length && out.toString('base64url') === text ? out : null;
}

export const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();

const edKey = (seed: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });

export const edPublic = (seed: Buffer): Buffer =>
  Buffer.from(createPublicKey(edKey(seed)).export({ format: 'der', type: 'spki' })).subarray(-32);

export const edSign = (seed: Buffer, message: string): Buffer => sign(null, Buffer.from(message, 'utf8'), edKey(seed));

export const relayId = (key: Buffer): string =>
  b64u(sha256(Buffer.concat([Buffer.from('cezar-relay-id-v1\n', 'ascii'), key])).subarray(0, 16));

export const socketProof = (role: 'cezar' | 'phone' | 'pair', id: string, device: string, time: number): string =>
  ['cezar-relay-v1', role, id, device, String(time)].join('\n');

export interface ProofHeaders {
  'X-Cezar-Relay-Key': string;
  'X-Cezar-Relay-Time': string;
  'X-Cezar-Relay-Sig': string;
}

export function proofHeaders(seed: Buffer, proof: string, time: number): ProofHeaders {
  return {
    'X-Cezar-Relay-Key': b64u(edPublic(seed)),
    'X-Cezar-Relay-Time': String(time),
    'X-Cezar-Relay-Sig': b64u(edSign(seed, proof)),
  };
}

// ---- relay address (§ 3, § 9.1) -----------------------------------------------------------------

const CLEARTEXT_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `CEZ_RELAY_URL` to its origin, or `null` when § 9.1 refuses it. One trailing `/` is accepted. */
export function parseRelayOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::([1-9][0-9]{0,4}))?\/?$/.exec(value);
  if (!match) return null;
  const [, scheme, host, port] = match as unknown as [string, string, string, string | undefined];
  if (port !== undefined && Number(port) > 65535) return null;
  if (scheme === 'http' && !CLEARTEXT_HOSTS.has(host)) return null;
  return `${scheme}://${host}${port ? `:${port}` : ''}`;
}

/** `CEZ_RELAY=0` blocks everything; otherwise the origin decides, § 9.1. */
export function relayOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CEZ_RELAY === '0' ? null : parseRelayOrigin(env.CEZ_RELAY_URL);
}

export const socketOrigin = (origin: string): string => origin.replace(/^http/, 'ws');

export const qrString = (origin: string, secret: Buffer, cezarKey: Buffer): string =>
  `${origin}/p#1.${b64u(secret)}.${b64u(cezarKey)}`;

// ---- pairing secrets (§ 9.2) --------------------------------------------------------------------

const SALT = Buffer.from('cezar-relay-pair-salt-v1', 'ascii');
const hkdf = (ikm: Buffer, info: string, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, SALT, Buffer.from(info, 'ascii'), length));

export interface PairingKeys {
  locator: Buffer;
  psk: Buffer;
}

export const deriveFromSecret = (secret: Buffer): PairingKeys => ({
  locator: hkdf(secret, 'cezar-pair-locator-v1', 32),
  psk: hkdf(secret, 'cezar-pair-psk-v1', 32),
});

export async function deriveFromCode(code: string): Promise<PairingKeys> {
  const okm = await pbkdf2Async(Buffer.from(code, 'ascii'), Buffer.from('cezar-pair-code-v1', 'ascii'), 200_000, 64, 'sha256');
  return { locator: okm.subarray(0, 32), psk: okm.subarray(32) };
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const generateCode = (): string =>
  Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(32)]).join('');

export const displayCode = (code: string): string => code.replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');

export const sas = (handshakeHash: Buffer): string =>
  String(hkdf(handshakeHash, 'cezar-pair-sas-v1', 4).readUInt32BE(0) % 1_000_000).padStart(6, '0');

export const pairPrologue = (locator: Buffer): Buffer =>
  Buffer.concat([Buffer.from('cezar-pair-v1', 'ascii'), locator]);

export const sessionPrologue = (cezarId: string, deviceId: string): Buffer =>
  Buffer.concat([
    Buffer.from('cezar-session-v1', 'ascii'),
    Buffer.from(cezarId, 'base64url'),
    Buffer.from(deviceId, 'base64url'),
  ]);

// ---- records (§ 11) -----------------------------------------------------------------------------

export function encodeRecord(content: Buffer): Buffer {
  const out = Buffer.alloc(Math.max(256, Math.ceil((2 + content.length) / 256) * 256));
  out.writeUInt16BE(content.length, 0);
  content.copy(out, 2);
  return out;
}

export function decodeRecord(record: Buffer): Buffer {
  if (record.length === 0 || record.length % 256 !== 0) throw new Error('record size');
  const length = record.readUInt16BE(0);
  if (2 + length > record.length) throw new Error('record length');
  for (let at = 2 + length; at < record.length; at += 1) {
    if (record[at] !== 0) throw new Error('record padding');
  }
  return record.subarray(2, 2 + length);
}

// ---- limits (§ 8) -------------------------------------------------------------------------------

export const LIMIT_DEFAULTS = {
  frameBytes: 65_552,
  controlBytes: 8_192,
  devices: 10,
  framesPerSecond: 500,
} as const;
export const RENDEZVOUS_FRAME_BYTES = 16_384;

export function sizes(frameBytes: number): { maxCiphertext: number; maxRecord: number; maxContent: number; maxData: number } {
  const maxCiphertext = Math.min(65_535, frameBytes - 17);
  const maxRecord = Math.floor((maxCiphertext - 16) / 256) * 256;
  return { maxCiphertext, maxRecord, maxContent: maxRecord - 2, maxData: maxRecord - 7 };
}

// ---- tunnel frames (§ 12) -----------------------------------------------------------------------

export type TunnelHeaders = [name: string, value: string][];

export type TunnelFrame =
  | { type: 'hello'; min: number; max: number }
  | { type: 'open'; stream: number; method: string; target: string; headers: TunnelHeaders }
  | { type: 'head'; stream: number; status: number; headers: TunnelHeaders }
  | { type: 'data'; stream: number; data: Buffer }
  | { type: 'end'; stream: number }
  | { type: 'reset'; stream: number; code: number }
  | { type: 'window'; stream: number; increment: number }
  | { type: 'lease' }
  | { type: 'rekey' }
  | { type: 'close'; code: number };

export const RESET = { cancelled: 1, flowControl: 2, badRequest: 3, tooManyStreams: 4, headTooLarge: 5, internal: 6 } as const;
export const CLOSE = { normal: 1, goodbye: 2, leaseExpired: 3, protocolError: 4, tunnelUnsupported: 5, deviceRemoved: 6 } as const;

const TYPE = { hello: 0, open: 1, head: 2, data: 3, end: 4, reset: 5, window: 6, lease: 7, rekey: 8, close: 9 } as const;
const TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_VALUE = /[\r\n\0]/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Largest `OPEN` or `HEAD` content, § 13.1. */
export const MAX_HEAD_CONTENT = 16_000;
export const MAX_TARGET_BYTES = 8_192;

const u16 = (n: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(n, 0);
  return out;
};
const u32 = (n: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n, 0);
  return out;
};
const str8 = (text: string): Buffer => {
  const bytes = Buffer.from(text, 'latin1');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
};
const str16 = (text: string): Buffer => {
  const bytes = Buffer.from(text, 'latin1');
  return Buffer.concat([u16(bytes.length), bytes]);
};
const headerBytes = (headers: TunnelHeaders): Buffer =>
  Buffer.concat([u16(headers.length), ...headers.flatMap(([name, value]) => [str8(name), str16(value)])]);
const frame = (type: number, ...parts: Buffer[]): Buffer => Buffer.concat([Buffer.from([type]), ...parts]);

export function encodeFrame(item: TunnelFrame): Buffer {
  switch (item.type) {
    case 'hello': return frame(TYPE.hello, u16(item.min), u16(item.max));
    case 'open': return frame(TYPE.open, u32(item.stream), str8(item.method), str16(item.target), headerBytes(item.headers));
    case 'head': return frame(TYPE.head, u32(item.stream), u16(item.status), headerBytes(item.headers));
    case 'data': return frame(TYPE.data, u32(item.stream), item.data);
    case 'end': return frame(TYPE.end, u32(item.stream));
    case 'reset': return frame(TYPE.reset, u32(item.stream), u16(item.code));
    case 'window': return frame(TYPE.window, u32(item.stream), u32(item.increment));
    case 'lease': return frame(TYPE.lease);
    case 'rekey': return frame(TYPE.rekey);
    case 'close': return frame(TYPE.close, u16(item.code));
  }
}

class Reader {
  private at = 0;
  constructor(private readonly buffer: Buffer) {}

  take(length: number): Buffer {
    if (this.at + length > this.buffer.length) throw new Error('truncated frame');
    const out = this.buffer.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
  u8(): number { return this.take(1)[0]!; }
  u16(): number { return this.take(2).readUInt16BE(0); }
  u32(): number { return this.take(4).readUInt32BE(0); }
  get left(): number { return this.buffer.length - this.at; }
  stream(): number {
    const id = this.u32();
    if (id === 0) throw new Error('stream zero');
    return id;
  }
}

function readHeaders(reader: Reader): TunnelHeaders {
  const list: TunnelHeaders = [];
  for (let left = reader.u16(); left > 0; left -= 1) {
    const name = reader.take(reader.u8()).toString('latin1');
    const value = reader.take(reader.u16()).toString('latin1');
    if (!TOKEN.test(name) || FORBIDDEN_VALUE.test(value)) throw new Error('bad header');
    list.push([name, value]);
  }
  return list;
}

/** Thrown for an `OPEN` a stream can refuse without ending the session (§ 13.1). */
export class OpenRefused extends Error {
  constructor(readonly stream: number, readonly code: number) {
    super('open refused');
  }
}

function readOpen(reader: Reader, size: number): TunnelFrame {
  const stream = reader.stream();
  const refuse = (code: number): OpenRefused => new OpenRefused(stream, code);
  if (size > MAX_HEAD_CONTENT) throw refuse(RESET.headTooLarge);
  const method = reader.take(reader.u8()).toString('latin1');
  const target = reader.take(reader.u16());
  const text = target.toString('latin1');
  let headers: TunnelHeaders;
  try {
    headers = readHeaders(reader);
  } catch {
    throw refuse(RESET.badRequest);
  }
  if (reader.left !== 0) throw new Error('trailing bytes');
  const ascii = target.every((byte) => byte > 0x20 && byte < 0x7f);
  if (!METHODS.has(method) || !ascii || target.length > MAX_TARGET_BYTES || !/^\/(?!\/)/.test(text)) throw refuse(RESET.badRequest);
  return { type: 'open', stream, method, target: text, headers };
}

/** Throws on anything § 12 calls malformed; an `OPEN` broken by § 13.1 is an {@link OpenRefused}. */
export function decodeFrame(content: Buffer): TunnelFrame {
  const reader = new Reader(content);
  const type = reader.u8();
  let out: TunnelFrame;
  switch (type) {
    case TYPE.hello: out = { type: 'hello', min: reader.u16(), max: reader.u16() }; break;
    case TYPE.open: return readOpen(reader, content.length);
    case TYPE.head: {
      const stream = reader.stream();
      const status = reader.u16();
      const headers = readHeaders(reader);
      if (status < 200 || status > 599) throw new Error('bad status');
      out = { type: 'head', stream, status, headers };
      break;
    }
    case TYPE.data: out = { type: 'data', stream: reader.stream(), data: reader.take(reader.left) }; break;
    case TYPE.end: out = { type: 'end', stream: reader.stream() }; break;
    case TYPE.reset: out = { type: 'reset', stream: reader.stream(), code: reader.u16() }; break;
    case TYPE.window: {
      const stream = reader.stream();
      const increment = reader.u32();
      if (increment === 0) throw new Error('window of zero');
      out = { type: 'window', stream, increment };
      break;
    }
    case TYPE.lease: out = { type: 'lease' }; break;
    case TYPE.rekey: out = { type: 'rekey' }; break;
    case TYPE.close: out = { type: 'close', code: reader.u16() }; break;
    default: throw new Error('unknown frame type');
  }
  if (reader.left !== 0) throw new Error('trailing bytes');
  return out;
}

/** The headers both the proxy and the dispatcher remove, so a modified app cannot look local. */
export function isDroppedRequestHeader(name: string): boolean {
  return (
    DROPPED_HEADERS.has(name) ||
    name.startsWith('x-forwarded-') ||
    name.startsWith('sec-fetch-')
  );
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const DROPPED_HEADERS = new Set(['host', 'origin', 'cookie', 'authorization', 'x-cezar-runtime-handoff', 'forwarded', 'x-real-ip', ...HOP_BY_HOP]);
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set(HOP_BY_HOP);

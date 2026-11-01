// The relay wire formats, as RELAY_PROTOCOL.md defines them. Reference code for the generator.
import { createHash, createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync, sign } from 'node:crypto'

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

export const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
export const sha256 = (data) => createHash('sha256').update(data).digest()

const edKey = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
export const edPublic = (seed) =>
  Buffer.from(createPublicKey(edKey(seed)).export({ format: 'der', type: 'spki' })).subarray(-32)
export const edSign = (seed, message) => sign(null, Buffer.from(message, 'utf8'), edKey(seed))

export const relayId = (key) =>
  b64u(sha256(Buffer.concat([Buffer.from('cezar-relay-id-v1\n', 'ascii'), key])).subarray(0, 16))

export const socketProof = (role, id, device, time) => ['cezar-relay-v1', role, id, device, String(time)].join('\n')
export const postProof = (path, body, time) =>
  ['cezar-relay-post-v1', path, sha256(body).toString('hex'), '-', String(time)].join('\n')

const SALT = Buffer.from('cezar-relay-pair-salt-v1', 'ascii')
const hkdf = (ikm, info, length) => Buffer.from(hkdfSync('sha256', ikm, SALT, Buffer.from(info, 'ascii'), length))

export const deriveFromSecret = (secret) => ({
  locator: hkdf(secret, 'cezar-pair-locator-v1', 32),
  psk: hkdf(secret, 'cezar-pair-psk-v1', 32),
})

export function deriveFromCode(code) {
  const okm = pbkdf2Sync(Buffer.from(code, 'ascii'), Buffer.from('cezar-pair-code-v1', 'ascii'), 200_000, 64, 'sha256')
  return { locator: okm.subarray(0, 32), psk: okm.subarray(32) }
}

export const sas = (handshakeHash) =>
  String(hkdf(handshakeHash, 'cezar-pair-sas-v1', 4).readUInt32BE(0) % 1_000_000).padStart(6, '0')

export const pairPrologue = (locator) => Buffer.concat([Buffer.from('cezar-pair-v1', 'ascii'), locator])
export const sessionPrologue = (cezarId, deviceId) =>
  Buffer.concat([Buffer.from('cezar-session-v1', 'ascii'), Buffer.from(cezarId, 'base64url'), Buffer.from(deviceId, 'base64url')])

export function record(content) {
  const padded = Math.max(256, Math.ceil((2 + content.length) / 256) * 256)
  const out = Buffer.alloc(padded)
  out.writeUInt16BE(content.length, 0)
  content.copy(out, 2)
  return out
}

const u16 = (n) => {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(n, 0)
  return out
}
const u32 = (n) => {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(n, 0)
  return out
}
const short = (text) => Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text, 'utf8')])
const long = (text) => Buffer.concat([u16(Buffer.byteLength(text)), Buffer.from(text, 'utf8')])
const headers = (list) => Buffer.concat([u16(list.length), ...list.flatMap(([name, value]) => [short(name), long(value)])])

export const TYPE = { HELLO: 0, OPEN: 1, HEAD: 2, DATA: 3, END: 4, RESET: 5, WINDOW: 6, LEASE: 7, REKEY: 8, CLOSE: 9 }
const frame = (type, ...parts) => Buffer.concat([Buffer.from([type]), ...parts])

export const encode = {
  hello: (min, max) => frame(TYPE.HELLO, u16(min), u16(max)),
  open: (stream, method, target, list) => frame(TYPE.OPEN, u32(stream), short(method), long(target), headers(list)),
  head: (stream, status, list) => frame(TYPE.HEAD, u32(stream), u16(status), headers(list)),
  data: (stream, bytes) => frame(TYPE.DATA, u32(stream), bytes),
  end: (stream) => frame(TYPE.END, u32(stream)),
  reset: (stream, code) => frame(TYPE.RESET, u32(stream), u16(code)),
  window: (stream, increment) => frame(TYPE.WINDOW, u32(stream), u32(increment)),
  lease: () => frame(TYPE.LEASE),
  rekey: () => frame(TYPE.REKEY),
  close: (code) => frame(TYPE.CLOSE, u16(code)),
}

export function sizes(frameBytes) {
  const maxCiphertext = Math.min(65_535, frameBytes - 17)
  const maxRecord = Math.floor((maxCiphertext - 16) / 256) * 256
  return { maxCiphertext, maxRecord, maxContent: maxRecord - 2, maxData: maxRecord - 7 }
}

export const dataFrames = {
  phoneToRelay: (ciphertext) => Buffer.concat([Buffer.from([1]), ciphertext]),
  routed: (deviceId, ciphertext) => Buffer.concat([Buffer.from([1]), Buffer.from(deviceId, 'base64url'), ciphertext]),
}

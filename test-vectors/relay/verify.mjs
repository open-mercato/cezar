#!/usr/bin/env node
// Independent re-check of the vectors: node: built-ins only, sharing no code with generator/.
// Covers proofs, ids, QR parsing, derivations, the six digits, frames, records and transport decryption.
import assert from 'node:assert/strict'
import { createDecipheriv, createHash, createHmac, createPublicKey, pbkdf2Sync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const bytes = (text) => Buffer.from(text, 'hex')
let checks = 0
const same = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks += 1
}

const B64 = /^[A-Za-z0-9_-]+$/
function unb64(text, length) {
  if (!B64.test(text)) return null
  const out = Buffer.from(text, 'base64url')
  if (out.length !== length || out.toString('base64url') !== text) return null
  return out
}

// RFC 5869 by hand on HMAC, so a bug in the generator's hkdf call cannot hide here.
function hkdf(ikm, salt, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  let block = Buffer.alloc(0)
  let okm = Buffer.alloc(0)
  for (let i = 1; okm.length < length; i += 1) {
    block = createHmac('sha256', prk).update(block).update(info).update(Buffer.from([i])).digest()
    okm = Buffer.concat([okm, block])
  }
  return okm.subarray(0, length)
}
const SALT = Buffer.from('cezar-relay-pair-salt-v1')
const relayId = (key) =>
  createHash('sha256').update('cezar-relay-id-v1\n').update(key).digest().subarray(0, 16).toString('base64url')
const edVerify = (key, text, sig) =>
  verify(null, Buffer.from(text), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' }), sig)

// Proofs. The first case repeats the spec's values literally.
const proofs = load('proof.json')
const spec = proofs.sockets[0]
same(spec.key, 'iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w', 'spec key')
same(spec.id, 'JG0cluinRjn-lvNKCdLU5w', 'spec id')
same(spec.sig, 'V68ncyA98yXD5r524pXn17WZs8PNJKCytyw41XCAcEceSEkQJyYg99SHobPMZKg_qtS2VVmoblfOyvCV9eY4Dg', 'spec sig')
same(spec.proofString, `cezar-relay-v1\ncezar\n${spec.id}\n-\n1793491200`, 'spec proof string')
for (const proof of [...proofs.sockets, ...proofs.posts]) {
  const key = unb64(proof.key, 32)
  same(relayId(key), proof.id, `${proof.name}: id`)
  same(edVerify(key, proof.proofString, unb64(proof.sig, 64)), true, `${proof.name}: signature`)
}
for (const post of proofs.posts) {
  const hash = createHash('sha256').update(post.body).digest('hex')
  same(post.proofString, `cezar-relay-post-v1\n${post.path}\n${hash}\n-\n${post.time}`, `${post.name}: string`)
}

// QR grammar.
const DEBUG_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
function parseQr(qr) {
  const match = /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::([1-9][0-9]{0,4}))?\/p#([0-9]+)\.([^.]*)\.([^.]*)$/.exec(qr)
  if (!match) return { refused: 'grammar' }
  const [, scheme, host, port, version, secret, key] = match
  if (port && Number(port) > 65535) return { refused: 'grammar' }
  if (version !== '1') return { refused: 'version' }
  const secretBytes = unb64(secret, 32)
  const keyBytes = unb64(key, 32)
  if (!secretBytes || !keyBytes) return { refused: 'grammar' }
  if (scheme === 'http' && !DEBUG_HOSTS.has(host)) return { refused: 'cleartext' }
  const origin = `${scheme}://${host}${port ? `:${port}` : ''}`
  return { origin, scheme, secret: secretBytes, key: keyBytes }
}
const qrs = load('qr.json')
same(hkdf(bytes(qrs.secret), SALT, Buffer.from('cezar-pair-locator-v1'), 32).toString('hex'), qrs.locatorHex, 'locator')
same(hkdf(bytes(qrs.secret), SALT, Buffer.from('cezar-pair-psk-v1'), 32).toString('hex'), qrs.psk, 'psk')
same(bytes(qrs.locatorHex).toString('base64url'), qrs.locator, 'locator text')
for (const item of qrs.accepted) {
  const parsed = parseQr(item.qr)
  same(parsed.origin, item.relayOrigin, item.qr)
  same(parsed.origin.replace(/^http/, 'ws'), item.socketOrigin, `${item.qr}: socket`)
  same(parsed.secret.toString('hex'), qrs.secret, `${item.qr}: secret`)
  same(parsed.key.toString('hex'), qrs.cezarX25519, `${item.qr}: key`)
  same(parsed.scheme === 'https', item.release, `${item.qr}: release`)
  same(item.debug, true, `${item.qr}: debug`)
}
for (const item of qrs.refused) same(parseQr(item.qr).refused, item.reason, item.name)

// Typed code.
const codes = load('code.json')
function normalize(input) {
  const stripped = input.replace(/[ \-‐-―]/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase()).replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(stripped) ? stripped : null
}
for (const item of codes.cases) {
  for (const input of item.inputs) same(normalize(input), item.code, `normalize ${input}`)
  same(normalize(item.display), item.code, `display ${item.display}`)
  const okm = pbkdf2Sync(item.code, codes.salt, codes.iterations, codes.outputBytes, 'sha256')
  same(okm.subarray(0, 32).toString('hex'), item.locatorHex, `${item.code}: locator`)
  same(okm.subarray(32).toString('hex'), item.psk, `${item.code}: psk`)
}
for (const item of codes.refused) same(normalize(item.input), null, item.name)

// Six digits.
for (const item of load('sas.json').cases) {
  const value = hkdf(bytes(item.handshakeHash), SALT, Buffer.from('cezar-pair-sas-v1'), 4).readUInt32BE(0)
  same(String(value % 1000000).padStart(6, '0'), item.sas, item.name)
}

// Records and tunnel frames, parsed from bytes.
function unpad(record) {
  if (record.length === 0 || record.length % 256 !== 0) throw new Error('record size')
  const length = record.readUInt16BE(0)
  if (2 + length > record.length) throw new Error('record length')
  if (record.subarray(2 + length).some((byte) => byte !== 0)) throw new Error('padding')
  return record.subarray(2, 2 + length)
}
class Reader {
  constructor(buffer) {
    this.buffer = buffer
    this.at = 0
  }
  take(length) {
    if (this.at + length > this.buffer.length) throw new Error('truncated')
    const out = this.buffer.subarray(this.at, this.at + length)
    this.at += length
    return out
  }
  u8() { return this.take(1)[0] }
  u16() { return this.take(2).readUInt16BE(0) }
  u32() { return this.take(4).readUInt32BE(0) }
  end() { if (this.at !== this.buffer.length) throw new Error('trailing bytes') }
}
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
function readHeaders(reader) {
  const list = []
  for (let left = reader.u16(); left > 0; left -= 1) {
    const name = reader.take(reader.u8()).toString('latin1')
    const value = reader.take(reader.u16()).toString('latin1')
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error('header')
    list.push([name, value])
  }
  return list
}
function stream(reader) {
  const id = reader.u32()
  if (id === 0) throw new Error('stream zero')
  return id
}
function parseFrame(content) {
  const reader = new Reader(content)
  const type = reader.u8()
  const out = {}
  switch (type) {
    case 0: out.min = reader.u16(); out.max = reader.u16(); break
    case 1:
      out.stream = stream(reader)
      out.method = reader.take(reader.u8()).toString('latin1')
      out.target = reader.take(reader.u16()).toString('latin1')
      out.headers = readHeaders(reader)
      if (!METHODS.has(out.method) || !/^\/(?!\/)/.test(out.target)) throw new Error('open')
      break
    case 2:
      out.stream = stream(reader)
      out.status = reader.u16()
      out.headers = readHeaders(reader)
      if (out.status < 200 || out.status > 599) throw new Error('status')
      break
    case 3: out.stream = stream(reader); out.data = reader.take(content.length - 5).toString('hex'); break
    case 4: out.stream = stream(reader); break
    case 5: out.stream = stream(reader); out.code = reader.u16(); break
    case 6:
      out.stream = stream(reader)
      out.increment = reader.u32()
      if (out.increment === 0) throw new Error('window')
      break
    case 7: case 8: break
    case 9: out.code = reader.u16(); break
    default: throw new Error('frame type')
  }
  reader.end()
  return out
}
const tunnel = load('tunnel-frames.json')
for (const item of tunnel.frames) {
  same(unpad(bytes(item.record)).toString('hex'), item.content, `${item.name}: record`)
  same(parseFrame(bytes(item.content)), item.fields, `${item.name}: fields`)
}
for (const item of tunnel.padding) {
  same(item.recordLength, Math.max(256, Math.ceil((item.contentLength + 2) / 256) * 256), `padding ${item.contentLength}`)
  const record = Buffer.alloc(item.recordLength)
  record.writeUInt16BE(item.contentLength, 0)
  record.fill(0xab, 2, 2 + item.contentLength)
  same(createHash('sha256').update(record).digest('hex'), item.recordSha256, `padding hash ${item.contentLength}`)
}
for (const item of tunnel.limits) {
  const maxCiphertext = Math.min(65535, item.frameBytes - 17)
  const maxRecord = (maxCiphertext - 16) - ((maxCiphertext - 16) % 256)
  same([item.maxCiphertext, item.maxRecord, item.maxContent, item.maxData], [maxCiphertext, maxRecord, maxRecord - 2, maxRecord - 7], `limits ${item.frameBytes}`)
  same(1 + 16 + item.maxRecord + 16 <= item.frameBytes, true, `frame fits ${item.frameBytes}`)
}
same(tunnel.chunking.chunks.reduce((a, b) => a + b, 0), tunnel.chunking.bodyBytes, 'chunks sum')
same(tunnel.chunking.chunks.every((size) => size <= tunnel.chunking.maxData), true, 'chunks fit')

// Data frames per hop.
const frames = load('frames.json')
same(unb64(frames.deviceId, 16).toString('hex'), frames.deviceIdHex, 'device id bytes')
same(frames.data.phoneToRelay, `01${frames.ciphertext}`, 'phone to relay')
same(frames.data.relayToCezar, `01${frames.deviceIdHex}${frames.ciphertext}`, 'relay to cezar')
same(frames.data.cezarToRelay, frames.data.relayToCezar, 'cezar to relay')
same(frames.data.relayToPhone, frames.data.phoneToRelay, 'relay to phone')
same(frames.data.rendezvous, frames.data.phoneToRelay, 'rendezvous')

// Transport: AEAD by hand from the published keys. ChaCha20-Poly1305 nonce = 4 zero bytes, then n LE.
function open(key, n, ciphertext) {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64LE(BigInt(n), 4)
  const decipher = createDecipheriv('chacha20-poly1305', bytes(key), nonce, { authTagLength: 16 })
  if (ciphertext.length < 16) throw new Error('short')
  decipher.setAAD(Buffer.alloc(0), { plaintextLength: ciphertext.length - 16 })
  decipher.setAuthTag(ciphertext.subarray(-16))
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
}
const pair = load('handshake-xxpsk3.json')
same(pair.prologue, Buffer.concat([Buffer.from('cezar-pair-v1'), bytes(qrs.locatorHex)]).toString('hex'), 'pair prologue')
same(pair.psk, qrs.psk, 'pair psk')
same(pair.messages[0].payload, '', 'first pairing message is empty')
same(pair.messages[1].payload, '', 'second pairing message is empty')
same(pair.messages.map((message) => message.bytes), [48, 96, 320], 'pairing message sizes')
const phonePayload = JSON.parse(unpad(bytes(pair.messages[2].payload)).toString('utf8'))
same(phonePayload.relayKey, pair.phone.relayKey, 'phone payload key')
same(relayId(unb64(pair.phone.relayKey, 32)), pair.phone.deviceId, 'device id')
same(relayId(unb64(pair.cezar.relayKey, 32)), pair.cezar.cezarId, 'cezar id')
const pending = pair.afterHandshake.pending
same(unpad(open(pair.transportKeys.cezarToPhone, 0, bytes(pending.ciphertext))).toString('utf8'), pending.text, 'pending')
for (const item of pair.afterHandshake.outcomesAtNonce1) {
  same(unpad(open(pair.transportKeys.cezarToPhone, 1, bytes(item.ciphertext))).toString('utf8'), item.text, item.name)
}
for (const item of pair.afterHandshake.failuresWithoutPending) {
  same(item.nonce, 0, `${item.name}: nonce`)
  same(unpad(open(pair.transportKeys.cezarToPhone, 0, bytes(item.ciphertext))).toString('utf8'), item.text, item.name)
}
const session = load('session-kk.json')
same(session.prologue, Buffer.concat([Buffer.from('cezar-session-v1'), unb64(session.cezarId, 16), unb64(session.deviceId, 16)]).toString('hex'), 'session prologue')
same(session.first.bytes, 48, 'first KK message size')
same(session.prologue.length, 2 * 48, 'session prologue size')
for (const item of session.transcript) {
  const key = item.from === 'phone' ? session.transportKeys.phoneToCezar : session.transportKeys.cezarToPhone
  same(open(key, item.nonce, bytes(item.ciphertext)).toString('hex'), item.record, `${item.name}: decrypts`)
  same(unpad(bytes(item.record)).toString('hex'), item.content, `${item.name}: record`)
  parseFrame(bytes(item.content))
  const device = bytes(session.prologue).subarray(32).toString('hex')
  const routed = `01${device}${item.ciphertext}`
  same(item.from === 'phone' ? item.relayToCezar : item.cezarToRelay, routed, `${item.name}: routed`)
  same(item.from === 'phone' ? item.phoneToRelay : item.relayToPhone, `01${item.ciphertext}`, `${item.name}: bare`)
}
same(parseFrame(bytes(session.transcript[0].content)), { min: 1, max: 1 }, 'HELLO comes first')

// Rekey: Noise's REKEY by hand.
function rekeyed(key) {
  const nonce = Buffer.alloc(12, 0xff)
  nonce.fill(0, 0, 4)
  return encryptZeros(bytes(key), nonce).toString('hex')
}
function encryptZeros(key, nonce) {
  const stream = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  // CTR keystream XOR zeros equals the ciphertext of zeros, in either direction.
  return stream.update(Buffer.alloc(32))
}
const rekey = load('rekey.json')
same(rekey.steps.map((step) => step.nonce), [0, 1, 2, 3, 4], 'nonces carry across rekeys')
same(rekey.steps[1].key, rekey.steps[0].key, 'REKEY frame uses the old key')
same(rekey.steps[2].key, rekeyed(rekey.steps[0].key), 'second key')
same(rekey.steps[4].key, rekeyed(rekey.steps[2].key), 'third key')
for (const step of rekey.steps) same(open(step.key, step.nonce, bytes(step.ciphertext)).toString('hex'), step.record, step.name)
same(open(rekey.otherDirection.key, 0, bytes(rekey.otherDirection.ciphertext)).toString('hex'), rekey.otherDirection.record, 'other direction')
same(rekey.otherDirection.key, session.transportKeys.cezarToPhone, 'other direction key unchanged')

// Negative cases that need no Noise state.
const negative = load('negative.json')
for (const item of negative.transport) {
  let n = 0
  for (const step of item.deliver) {
    if (step.expect === 'ok') {
      open(item.key, n, bytes(step.ciphertext))
      n += 1
      checks += 1
    } else {
      assert.throws(() => open(item.key, n, bytes(step.ciphertext)), undefined, item.name)
      checks += 1
    }
  }
}
assert.throws(() => open(negative.afterRekey.key, negative.afterRekey.nonce, bytes(negative.afterRekey.ciphertext)))
checks += 1
for (const item of negative.record) {
  assert.throws(() => unpad(bytes(item.record)), undefined, item.name)
  checks += 1
}
for (const item of negative.tunnel) {
  assert.throws(() => parseFrame(bytes(item.content)), undefined, item.name)
  checks += 1
}

console.log(`verify: ${checks} checks passed`)

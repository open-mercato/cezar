#!/usr/bin/env node
// Regenerates the vectors byte for byte. Usage: node generate.mjs [outDir]. Prints one hash over all of them.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CipherState, HandshakeState, x25519Public } from './noise.mjs'
import * as w from './wire.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = process.argv[2] ?? join(here, '..')
const EMPTY = Buffer.alloc(0)
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const seed = (label) => w.sha256(Buffer.from(`cezar-relay-vector-v1\n${label}`, 'utf8'))
const json = (value) => Buffer.from(JSON.stringify(value), 'utf8')
const out = {}

const TIME = 1793491200
const cezarEd = seed('cezar-ed25519')
const phoneEd = seed('phone-ed25519')
const cezarDh = seed('cezar-x25519')
const phoneDh = seed('phone-x25519')
const cezarKey = w.edPublic(cezarEd)
const phoneKey = w.edPublic(phoneEd)
const cezarId = w.relayId(cezarKey)
const deviceId = w.relayId(phoneKey)
const secret = seed('pairing-secret')
const { locator, psk } = w.deriveFromSecret(secret)
const locatorText = w.b64u(locator)

// --- relay proofs
const proof = (name, signer, line) => ({
  name,
  seed: hex(signer),
  key: w.b64u(w.edPublic(signer)),
  id: w.relayId(w.edPublic(signer)),
  time: TIME,
  proofString: line,
  sig: w.b64u(w.edSign(signer, line)),
})
const posts = [
  ['/v1/push-grants', phoneEd, { platform: 'android', token: 'fcm-token', cezarKey: w.b64u(cezarKey) }],
  ['/v1/push-grants/revoke', phoneEd, { grant: 'opaque-grant' }],
  ['/v1/push', cezarEd, { v: 1, grant: 'opaque-grant', kind: 'attention', count: 3, id: w.b64u(seed('push-id').subarray(0, 16)), ts: TIME }],
]
out['proof.json'] = {
  description: 'Ed25519 relay proofs. A randomized signer verifies `sig`; a deterministic one must reproduce it.',
  sockets: [
    proof('cezar socket, the spec vector', Buffer.alloc(32, 1), w.socketProof('cezar', w.relayId(w.edPublic(Buffer.alloc(32, 1))), '-', TIME)),
    proof('phone socket', phoneEd, w.socketProof('phone', cezarId, deviceId, TIME)),
    proof('rendezvous, cezar side', cezarEd, w.socketProof('pair', locatorText, '-', TIME)),
  ],
  posts: posts.map(([path, signer, body]) => {
    const raw = json(body).toString('utf8')
    return { ...proof(`POST ${path}`, signer, w.postProof(path, Buffer.from(raw, 'utf8'), TIME)), path, body: raw }
  }),
}

// --- QR
const pinned = w.b64u(x25519Public(cezarDh))
const qrTail = `#1.${w.b64u(secret)}.${pinned}`
const accepted = (origin, wsOrigin, release, debug) => ({
  qr: `${origin}/p${qrTail}`,
  relayOrigin: origin,
  socketOrigin: wsOrigin,
  release,
  debug,
})
const trailingBits = w.b64u(secret).slice(0, 42) + 'B'
out['qr.json'] = {
  description: 'QR parsing and the HKDF derivations. `release` and `debug` say whether that app build may connect.',
  secret: hex(secret),
  cezarX25519: hex(x25519Public(cezarDh)),
  locator: locatorText,
  locatorHex: hex(locator),
  psk: hex(psk),
  accepted: [
    accepted('https://relay.example.test', 'wss://relay.example.test', true, true),
    accepted('https://relay.example.test:8443', 'wss://relay.example.test:8443', true, true),
    accepted('https://cezar-relay.someone.workers.dev', 'wss://cezar-relay.someone.workers.dev', true, true),
    accepted('http://127.0.0.1:8787', 'ws://127.0.0.1:8787', false, true),
    accepted('http://localhost:8787', 'ws://localhost:8787', false, true),
    accepted('http://[::1]:8787', 'ws://[::1]:8787', false, true),
    accepted('http://10.0.2.2:8787', 'ws://10.0.2.2:8787', false, true),
  ],
  refused: [
    ['unsupported version', `https://relay.example.test/p#2.${w.b64u(secret)}.${pinned}`, 'version'],
    ['cleartext to a public host', `http://relay.example.test/p${qrTail}`, 'cleartext'],
    ['cleartext to another private address', `http://192.168.1.10:8787/p${qrTail}`, 'cleartext'],
    ['other scheme', `ftp://relay.example.test/p${qrTail}`, 'grammar'],
    ['uppercase scheme', `HTTPS://relay.example.test/p${qrTail}`, 'grammar'],
    ['uppercase host', `https://Relay.example.test/p${qrTail}`, 'grammar'],
    ['user info', `https://user@relay.example.test/p${qrTail}`, 'grammar'],
    ['port zero', `https://relay.example.test:0/p${qrTail}`, 'grammar'],
    ['port too large', `https://relay.example.test:65536/p${qrTail}`, 'grammar'],
    ['port with a leading zero', `https://relay.example.test:08443/p${qrTail}`, 'grammar'],
    ['other path', `https://relay.example.test/x${qrTail}`, 'grammar'],
    ['path prefix', `https://relay.example.test/relay/p${qrTail}`, 'grammar'],
    ['query', `https://relay.example.test/p?x=1${qrTail}`, 'grammar'],
    ['no fragment', 'https://relay.example.test/p', 'grammar'],
    ['missing field', `https://relay.example.test/p#1.${w.b64u(secret)}`, 'grammar'],
    ['extra field', `https://relay.example.test/p${qrTail}.x`, 'grammar'],
    ['short secret', `https://relay.example.test/p#1.${w.b64u(secret.subarray(1))}.${pinned}`, 'grammar'],
    ['padded base64', `https://relay.example.test/p#1.${w.b64u(secret)}=.${pinned}`, 'grammar'],
    ['standard base64 alphabet', `https://relay.example.test/p#1.+${w.b64u(secret).slice(1)}.${pinned}`, 'grammar'],
    ['non-canonical trailing bits', `https://relay.example.test/p#1.${trailingBits}.${pinned}`, 'grammar'],
  ].map(([name, qr, reason]) => ({ name, qr, reason })),
}

// --- typed code
const codeCase = (code, inputs) => {
  const derived = w.deriveFromCode(code)
  return { code, display: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, inputs, locator: w.b64u(derived.locator), locatorHex: hex(derived.locator), psk: hex(derived.psk) }
}
out['code.json'] = {
  description: 'Typed code normalization and PBKDF2 derivation.',
  alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
  salt: 'cezar-pair-code-v1',
  iterations: 200000,
  outputBytes: 64,
  cases: [
    codeCase('QRFX7KMD2NVB', ['QRFX-7KMD-2NVB', 'qrfx-7kmd-2nvb', 'QRFX 7KMD 2NVB', 'qrfx7kmd2nvb', ' QRFX–7KMD—2NVB ']),
    codeCase('0123456789AB', ['0123-4567-89AB', 'o123-4567-89ab', 'OI23-4567-89AB', 'Ol23-4567-89AB']),
    codeCase('ZZZZZZZZZZZZ', ['zzzz-zzzz-zzzz']),
  ],
  refused: [
    ['the letter U', 'QRFX-7KMD-2NVU'],
    ['eleven characters', 'QRFX-7KMD-2NV'],
    ['thirteen characters', 'QRFX-7KMD-2NVBB'],
    ['a non-ASCII letter', 'QRFX-7KMD-2NVÉ'],
    ['punctuation', 'QRFX.7KMD.2NVB'],
    ['empty', ''],
  ].map(([name, input]) => ({ name, input })),
}

// --- XXpsk3
const phoneRange = { min: 1, max: 1 }
const cezarRange = { min: 1, max: 1 }
const xx = () => ({
  phone: new HandshakeState({ pattern: 'XXpsk3', initiator: true, prologue: w.pairPrologue(locator), s: phoneDh, psk, e: seed('phone-xx-ephemeral') }),
  cezar: new HandshakeState({ pattern: 'XXpsk3', initiator: false, prologue: w.pairPrologue(locator), s: cezarDh, psk, e: seed('cezar-xx-ephemeral') }),
})
const phonePayloadText = JSON.stringify({ name: 'Pixel 9', platform: 'android', relayKey: w.b64u(phoneKey), tunnel: phoneRange })
const phonePayload = w.record(Buffer.from(phonePayloadText, 'utf8'))
const pair = xx()
const xxMessages = []
const pairStep = (from, to, payload, text) => {
  const message = from === 'phone' ? pair.phone.writeMessage(payload) : pair.cezar.writeMessage(payload)
  const read = to === 'phone' ? pair.phone.readMessage(message) : pair.cezar.readMessage(message)
  if (!read.equals(payload)) throw new Error('handshake payload mismatch')
  xxMessages.push({ from, payloadText: text, payload: hex(payload), message: hex(message), bytes: message.length, frame: hex(w.dataFrames.phoneToRelay(message)) })
}
pairStep('phone', 'cezar', EMPTY, null)
pairStep('cezar', 'phone', EMPTY, null)
pairStep('phone', 'cezar', phonePayload, phonePayloadText)
const pairHash = pair.phone.h
if (!pair.phone.rs.equals(x25519Public(cezarDh)) || !pair.cezar.rs.equals(x25519Public(phoneDh))) throw new Error('rs mismatch')
const pairPhone = pair.phone.split()
const pairCezar = pair.cezar.split()
const pairKeys = { phoneToCezar: hex(pairCezar.receive.k), cezarToPhone: hex(pairCezar.send.k) }
const pending = { t: 'pending', relayKey: w.b64u(cezarKey), tunnel: cezarRange, label: 'Test Mac' }
const pairMessage = (cipher, value, name) => {
  const text = JSON.stringify(value)
  const rec = w.record(Buffer.from(text, 'utf8'))
  const nonce = Number(cipher.n)
  const ciphertext = cipher.encrypt(EMPTY, rec)
  return { name, nonce, text, record: hex(rec), ciphertext: hex(ciphertext), frame: hex(w.dataFrames.phoneToRelay(ciphertext)) }
}
const pendingWire = pairMessage(pairCezar.send, pending, 'pending')
const outcomes = [
  ['approved', { t: 'approved' }],
  ['denied', { t: 'denied' }],
  ['failure device-limit', { t: 'failure', reason: 'device-limit' }],
  ['failure tunnel-unsupported', { t: 'failure', reason: 'tunnel-unsupported', tunnel: { min: 2, max: 3 } }],
].map(([name, value]) => pairMessage(Object.assign(new CipherState(pairCezar.send.k), { n: 1n }), value, name))
const pairDigits = w.sas(pairHash)
out['handshake-xxpsk3.json'] = {
  description: 'One full pairing. Phone is initiator. Every `frame` is the rendezvous data frame.',
  protocol: 'Noise_XXpsk3_25519_ChaChaPoly_SHA256',
  prologue: hex(w.pairPrologue(locator)),
  psk: hex(psk),
  phone: { x25519Secret: hex(phoneDh), x25519Public: hex(x25519Public(phoneDh)), ephemeralSecret: hex(seed('phone-xx-ephemeral')), ed25519Seed: hex(phoneEd), relayKey: w.b64u(phoneKey), deviceId },
  cezar: { x25519Secret: hex(cezarDh), x25519Public: hex(x25519Public(cezarDh)), ephemeralSecret: hex(seed('cezar-xx-ephemeral')), ed25519Seed: hex(cezarEd), relayKey: w.b64u(cezarKey), cezarId },
  messages: xxMessages,
  handshakeHash: hex(pairHash),
  sas: pairDigits,
  transportKeys: pairKeys,
  afterHandshake: { pending: pendingWire, outcomesAtNonce1: outcomes },
}

// --- six digits
const sasCases = [[pairHash, 'the XXpsk3 vector']]
for (let i = 0, found = 0; found < 2; i += 1) {
  const candidate = seed(`sas-${i}`)
  if (w.sas(candidate).startsWith('0')) {
    sasCases.push([candidate, `leading zero ${found + 1}`])
    found += 1
  }
}
out['sas.json'] = {
  description: 'The six digits, from the final handshake hash.',
  cases: sasCases.map(([hash, name]) => ({ name, handshakeHash: hex(hash), sas: w.sas(hash) })),
}

// --- KK session
const kkPrologue = w.sessionPrologue(cezarId, deviceId)
const phoneE = seed('phone-kk-ephemeral')
const cezarE = seed('cezar-kk-ephemeral')
const kkPhone = () => new HandshakeState({ pattern: 'KK', initiator: true, prologue: kkPrologue, s: phoneDh, rs: x25519Public(cezarDh), e: phoneE })
const kkCezar = () => new HandshakeState({ pattern: 'KK', initiator: false, prologue: kkPrologue, s: cezarDh, rs: x25519Public(phoneDh), e: cezarE })
const kkReplyText = JSON.stringify({ tunnel: cezarRange })
const kkReply = w.record(Buffer.from(kkReplyText, 'utf8'))
function runKk() {
  const phone = kkPhone()
  const cezar = kkCezar()
  const first = phone.writeMessage()
  cezar.readMessage(first)
  const second = cezar.writeMessage(kkReply)
  phone.readMessage(second)
  return { first, second, hash: phone.h, phone: phone.split(), cezar: cezar.split() }
}
const kk = runKk()
const session = []
const send = (from, name, content) => {
  const rec = w.record(content)
  const cipher = from === 'phone' ? kk.phone.send : kk.cezar.send
  const nonce = Number(cipher.n)
  const ciphertext = cipher.encrypt(EMPTY, rec)
  const receiver = from === 'phone' ? kk.cezar.receive : kk.phone.receive
  if (!receiver.decrypt(EMPTY, ciphertext).equals(rec)) throw new Error('transport mismatch')
  session.push({
    from, name, nonce, content: hex(content), record: hex(rec), ciphertext: hex(ciphertext),
    ...(from === 'phone'
      ? { phoneToRelay: hex(w.dataFrames.phoneToRelay(ciphertext)), relayToCezar: hex(w.dataFrames.routed(deviceId, ciphertext)) }
      : { cezarToRelay: hex(w.dataFrames.routed(deviceId, ciphertext)), relayToPhone: hex(w.dataFrames.phoneToRelay(ciphertext)) }),
  })
}
const body = Buffer.from('{"ok":true}', 'utf8')
send('phone', 'HELLO', w.encode.hello(1, 1))
send('phone', 'LEASE', w.encode.lease())
send('cezar', 'LEASE', w.encode.lease())
send('phone', 'OPEN', w.encode.open(1, 'GET', '/api/v1/health', [['accept', 'application/json'], ['user-agent', 'CezarMobile/1.0.0 (android)']]))
send('phone', 'END', w.encode.end(1))
send('cezar', 'HEAD', w.encode.head(1, 200, [['content-type', 'application/json'], ['content-length', String(body.length)]]))
send('cezar', 'DATA', w.encode.data(1, body))
send('cezar', 'END', w.encode.end(1))
send('phone', 'WINDOW', w.encode.window(1, body.length))
const wire = (message) => ({ message: hex(message), bytes: message.length, phoneToRelay: hex(w.dataFrames.phoneToRelay(message)), relayToCezar: hex(w.dataFrames.routed(deviceId, message)) })
out['session-kk.json'] = {
  description: 'One session: handshake, then a health request through the tunnel. Frames carry the wire headers for each hop.',
  protocol: 'Noise_KK_25519_ChaChaPoly_SHA256',
  cezarId,
  deviceId,
  prologue: hex(kkPrologue),
  phone: { x25519Secret: hex(phoneDh), x25519Public: hex(x25519Public(phoneDh)), ephemeralSecret: hex(phoneE) },
  cezar: { x25519Secret: hex(cezarDh), x25519Public: hex(x25519Public(cezarDh)), ephemeralSecret: hex(cezarE) },
  first: wire(kk.first),
  second: { payloadText: kkReplyText, payload: hex(kkReply), message: hex(kk.second), bytes: kk.second.length, cezarToRelay: hex(w.dataFrames.routed(deviceId, kk.second)), relayToPhone: hex(w.dataFrames.phoneToRelay(kk.second)) },
  handshakeHash: hex(kk.hash),
  transportKeys: { phoneToCezar: hex(runKk().phone.send.k), cezarToPhone: hex(runKk().cezar.send.k) },
  transcript: session,
}

// --- tunnel frames
const framed = (name, fields, content) => ({ name, fields, content: hex(content), record: hex(w.record(content)) })
const bigHeaders = [['content-type', 'text/event-stream'], ['cache-control', 'no-store'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']]
const tunnelCases = [
  framed('HELLO', { min: 1, max: 3 }, w.encode.hello(1, 3)),
  framed('OPEN with no headers', { stream: 1, method: 'GET', target: '/', headers: [] }, w.encode.open(1, 'GET', '/', [])),
  framed('OPEN with a query and headers', { stream: 7, method: 'POST', target: '/api/v1/p/default/runs?x=1&y=%C5%BC', headers: [['content-type', 'application/json'], ['content-length', '2']] }, w.encode.open(7, 'POST', '/api/v1/p/default/runs?x=1&y=%C5%BC', [['content-type', 'application/json'], ['content-length', '2']])),
  framed('HEAD with a repeated header', { stream: 7, status: 200, headers: bigHeaders }, w.encode.head(7, 200, bigHeaders)),
  framed('DATA', { stream: 7, data: '7b7d' }, w.encode.data(7, Buffer.from('{}'))),
  framed('END', { stream: 7 }, w.encode.end(7)),
  ...[['cancelled', 1], ['flow-control', 2], ['bad-request', 3], ['too-many-streams', 4], ['head-too-large', 5], ['internal', 6]].map(([label, code]) => framed(`RESET ${label}`, { stream: 7, code }, w.encode.reset(7, code))),
  framed('WINDOW', { stream: 7, increment: 262144 }, w.encode.window(7, 262144)),
  framed('LEASE', {}, w.encode.lease()),
  framed('REKEY', {}, w.encode.rekey()),
  ...[['normal', 1], ['goodbye', 2], ['lease-expired', 3], ['protocol-error', 4], ['tunnel-unsupported', 5], ['device-removed', 6]].map(([label, code]) => framed(`CLOSE ${label}`, { code }, w.encode.close(code))),
]
const paddingCases = [0, 1, 254, 255, 510, 511, 65278].map((length) => {
  const rec = w.record(Buffer.alloc(length, 0xab))
  return { contentLength: length, recordLength: rec.length, recordSha256: hex(w.sha256(rec)) }
})
const limitCases = [65552, 16384].map((frameBytes) => ({ frameBytes, ...w.sizes(frameBytes) }))
const largest = w.sizes(65552).maxData
const chunked = (total) => {
  const chunks = []
  for (let left = total; left > 0; left -= Math.min(left, largest)) chunks.push(Math.min(left, largest))
  return chunks
}
out['tunnel-frames.json'] = {
  description: 'Each tunnel frame as content and as its padded record. `content` is what the fields encode to.',
  frames: tunnelCases,
  padding: paddingCases,
  limits: limitCases,
  chunking: { frameBytes: 65552, maxData: largest, bodyBytes: 200000, chunks: chunked(200000) },
}

// --- data frames and control frames
out['frames.json'] = {
  description: 'Relay data frames per hop, and control frames as exact JSON.',
  deviceId,
  deviceIdHex: hex(Buffer.from(deviceId, 'base64url')),
  ciphertext: 'c0ffee',
  data: {
    phoneToRelay: hex(w.dataFrames.phoneToRelay(Buffer.from('c0ffee', 'hex'))),
    relayToCezar: hex(w.dataFrames.routed(deviceId, Buffer.from('c0ffee', 'hex'))),
    cezarToRelay: hex(w.dataFrames.routed(deviceId, Buffer.from('c0ffee', 'hex'))),
    relayToPhone: hex(w.dataFrames.phoneToRelay(Buffer.from('c0ffee', 'hex'))),
    rendezvous: hex(w.dataFrames.phoneToRelay(Buffer.from('c0ffee', 'hex'))),
  },
  control: [
    { t: 'hello', protocol: 1, limits: { frameBytes: 65552, controlBytes: 8192 }, phones: [deviceId] },
    { t: 'hello', protocol: 1, limits: { frameBytes: 65552, controlBytes: 8192 }, cezar: 'online' },
    { t: 'hello', protocol: 1, limits: { frameBytes: 16384, controlBytes: 8192 } },
    { t: 'phone-joined', device: deviceId },
    { t: 'phone-left', device: deviceId },
    { t: 'cezar-online' },
    { t: 'cezar-offline' },
    { t: 'device-add', id: 'c1', device: deviceId, key: w.b64u(phoneKey) },
    { t: 'device-remove', id: 'c2', device: deviceId, grants: [w.b64u(seed('grant-id').subarray(0, 16))] },
    { t: 'device-sync', id: 'c3', devices: [{ device: deviceId, key: w.b64u(phoneKey) }] },
    { t: 'ack', id: 'c1' },
    { t: 'error', id: 'c2', code: 'too-many-grants' },
    { t: 'closing', retryAfter: 60 },
    { t: 'peer-joined' },
    { t: 'peer-left' },
    { t: 'pair-contested' },
  ],
}

// --- rekey
const rk = runKk()
const steps = []
const rekeyStep = (name, content, then) => {
  const rec = w.record(content)
  const before = hex(rk.phone.send.k)
  const nonce = Number(rk.phone.send.n)
  const ciphertext = rk.phone.send.encrypt(EMPTY, rec)
  if (!rk.cezar.receive.decrypt(EMPTY, ciphertext).equals(rec)) throw new Error('rekey mismatch')
  if (then) {
    rk.phone.send.rekey()
    rk.cezar.receive.rekey()
  }
  steps.push({ name, key: before, nonce, record: hex(rec), ciphertext: hex(ciphertext) })
}
rekeyStep('LEASE under the first key', w.encode.lease())
rekeyStep('REKEY, the last frame under the first key', w.encode.rekey(), true)
rekeyStep('LEASE under the second key, nonce continues', w.encode.lease())
rekeyStep('REKEY, the last frame under the second key', w.encode.rekey(), true)
rekeyStep('LEASE under the third key', w.encode.lease())
const reverseRec = w.record(w.encode.lease())
const reverseKey = hex(rk.cezar.send.k)
out['rekey.json'] = {
  description: 'Phone to cezar across two rekeys, on the session-kk.json keys. The other direction keeps its key.',
  steps,
  otherDirection: { name: 'LEASE from cezar after both rekeys', key: reverseKey, nonce: 0, record: hex(reverseRec), ciphertext: hex(rk.cezar.send.encrypt(EMPTY, reverseRec)) },
}

// --- negative cases
const neg = runKk()
const c0 = neg.phone.send.encrypt(EMPTY, w.record(w.encode.lease()))
const c1 = neg.phone.send.encrypt(EMPTY, w.record(w.encode.hello(1, 1)))
const reply = neg.cezar.send.encrypt(EMPTY, w.record(w.encode.lease()))
const tampered = Buffer.from(c0)
tampered[10] ^= 0x01
const tagTampered = Buffer.from(c0)
tagTampered[tagTampered.length - 1] ^= 0x80
const k0 = hex(runKk().cezar.receive.k)
const kkWithPayload = kkPhone().writeMessage(Buffer.from('early request', 'utf8'))
const lowOrder = (() => {
  const first = Buffer.from(kk.first)
  first.fill(0, 0, 32)
  return first
})()
const wrongPsk = xx()
wrongPsk.phone.psk = seed('wrong-psk')
const m1 = wrongPsk.phone.writeMessage()
wrongPsk.cezar.readMessage(m1)
wrongPsk.phone.readMessage(wrongPsk.cezar.writeMessage())
const m3 = wrongPsk.phone.writeMessage(phonePayload)
const spliced = new HandshakeState({ pattern: 'KK', initiator: true, prologue: w.sessionPrologue(deviceId, cezarId), s: phoneDh, rs: x25519Public(cezarDh), e: phoneE }).writeMessage()
const badRecord = (mutate) => {
  const rec = Buffer.from(w.record(w.encode.lease()))
  mutate(rec)
  return rec
}
out['negative.json'] = {
  description: 'Each case must end the session or be refused. `deliver` runs in order against one receiver at `key`, nonce 0.',
  transport: [
    { name: 'tampered ciphertext', key: k0, deliver: [{ ciphertext: hex(tampered), expect: 'fail' }] },
    { name: 'tampered tag', key: k0, deliver: [{ ciphertext: hex(tagTampered), expect: 'fail' }] },
    { name: 'reordered', key: k0, deliver: [{ ciphertext: hex(c1), expect: 'fail' }] },
    { name: 'replayed', key: k0, deliver: [{ ciphertext: hex(c0), expect: 'ok' }, { ciphertext: hex(c0), expect: 'fail' }] },
    { name: 'reflected from the other direction', key: k0, deliver: [{ ciphertext: hex(reply), expect: 'fail' }] },
    { name: 'truncated to under one tag', key: k0, deliver: [{ ciphertext: hex(c0.subarray(0, 15)), expect: 'fail' }] },
  ],
  afterRekey: { name: 'a frame under the old key after REKEY', key: steps[2].key, nonce: 2, ciphertext: hex(Object.assign(new CipherState(Buffer.from(steps[1].key, 'hex')), { n: 2n }).encrypt(EMPTY, w.record(w.encode.lease()))), expect: 'fail' },
  handshake: [
    { name: 'KK first message with a payload', pattern: 'KK', role: 'cezar', message: hex(kkWithPayload), expect: 'refuse', why: 'a first message is exactly 48 bytes, its payload empty' },
    { name: 'KK first message with a low-order ephemeral', pattern: 'KK', role: 'cezar', message: hex(lowOrder), expect: 'refuse', why: 'X25519 output must not be all zero' },
    { name: 'KK first message for another room', pattern: 'KK', role: 'cezar', message: hex(spliced), expect: 'refuse', why: 'the prologue names cezarId and deviceId' },
    { name: 'XXpsk3 third message under a wrong PSK', pattern: 'XXpsk3', role: 'cezar', messagesBefore: [hex(m1)], message: hex(m3), expect: 'refuse', why: 'psk3 fails decryption' },
    { name: 'XXpsk3 pin mismatch', pattern: 'XXpsk3', role: 'phone', pinned: hex(x25519Public(seed('someone-else'))), receivedStatic: hex(x25519Public(cezarDh)), expect: 'refuse', why: 'checked before the third message goes out' },
  ],
  record: [
    { name: 'non-zero padding', record: hex(badRecord((rec) => { rec[255] = 1 })), expect: 'refuse' },
    { name: 'length past the record', record: hex(badRecord((rec) => rec.writeUInt16BE(255, 0))), expect: 'refuse' },
    { name: 'not a multiple of 256', record: hex(w.record(w.encode.lease()).subarray(0, 255)), expect: 'refuse' },
    { name: 'empty', record: '', expect: 'refuse' },
  ],
  tunnel: [
    { name: 'unknown frame type', content: '7f', expect: 'refuse' },
    { name: 'stream id zero', content: hex(w.encode.end(0)), expect: 'refuse' },
    { name: 'END with trailing bytes', content: `${hex(w.encode.end(1))}00`, expect: 'refuse' },
    { name: 'truncated WINDOW', content: hex(w.encode.window(1, 1).subarray(0, 7)), expect: 'refuse' },
    { name: 'LEASE with a body', content: '0700', expect: 'refuse' },
    { name: 'WINDOW of zero', content: hex(w.encode.window(1, 0)), expect: 'refuse' },
    { name: 'header value with CR LF', content: hex(w.encode.open(1, 'GET', '/', [['x-a', 'b\r\nhost: 127.0.0.1']])), expect: 'refuse' },
    { name: 'uppercase header name', content: hex(w.encode.open(1, 'GET', '/', [['Host', 'x']])), expect: 'refuse' },
    { name: 'target without a leading slash', content: hex(w.encode.open(1, 'GET', 'http://evil/', [])), expect: 'refuse' },
    { name: 'target with two leading slashes', content: hex(w.encode.open(1, 'GET', '//evil/', [])), expect: 'refuse' },
    { name: 'CONNECT', content: hex(w.encode.open(1, 'CONNECT', '/', [])), expect: 'refuse' },
    { name: 'status 101', content: hex(w.encode.head(1, 101, [])), expect: 'refuse' },
  ],
}

// The handshake cases must really fail the way negative.json says.
const refuses = (run, label) => {
  try {
    run()
  } catch {
    return
  }
  throw new Error(`${label} was accepted`)
}
refuses(() => kkCezar().readMessage(lowOrder), 'low-order ephemeral')
refuses(() => kkCezar().readMessage(spliced), 'spliced prologue')
{
  const victim = xx()
  victim.cezar.readMessage(m1)
  victim.cezar.writeMessage()
  refuses(() => victim.cezar.readMessage(m3), 'wrong PSK')
}
// Noise itself accepts this one, so the 48-byte rule is what refuses it.
if (kkWithPayload.length === 48 || kkCezar().readMessage(kkWithPayload).length === 0) throw new Error('payload case is wrong')

mkdirSync(outDir, { recursive: true })
for (const [name, value] of Object.entries(out)) writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`)
const all = createHash('sha256')
for (const name of readdirSync(outDir).filter((file) => file.endsWith('.json')).sort()) all.update(name).update(readFileSync(join(outDir, name)))
console.log(`${Object.keys(out).length} files, sha256 ${all.digest('hex')}`)

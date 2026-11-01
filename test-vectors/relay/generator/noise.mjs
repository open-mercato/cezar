// Noise (revision 34) for 25519_ChaChaPoly_SHA256, over node:crypto (OpenSSL) only.
// Unaudited state machine, thin on purpose: every primitive is OpenSSL's. See RELAY_PROTOCOL.md § Noise.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto'

const EMPTY = Buffer.alloc(0)
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

const privateKey = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' })
const publicKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' })

export const x25519Public = (secret) =>
  Buffer.from(createPublicKey(privateKey(secret)).export({ format: 'der', type: 'spki' })).subarray(-32)

export function generateX25519() {
  const { privateKey: priv } = generateKeyPairSync('x25519')
  const secret = Buffer.from(priv.export({ format: 'der', type: 'pkcs8' })).subarray(-32)
  return { secret, public: x25519Public(secret) }
}

// OpenSSL refuses a low-order peer key (an all-zero output), which the contract requires.
const dh = (secret, peer) => diffieHellman({ privateKey: privateKey(secret), publicKey: publicKey(peer) })
const sha256 = (...parts) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}
// Noise's HKDF(ck, ikm, n) is RFC 5869 with salt = ck and empty info.
const hkdf = (ck, ikm, outputs) => {
  const okm = Buffer.from(hkdfSync('sha256', ikm, ck, EMPTY, 32 * outputs))
  return Array.from({ length: outputs }, (_, i) => okm.subarray(i * 32, (i + 1) * 32))
}

const nonceBytes = (n) => {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64LE(n, 4)
  return nonce
}

const MAX_NONCE = 0xffffffffffffffffn

export class CipherState {
  constructor(k = null) {
    this.k = k
    this.n = 0n
  }

  encrypt(ad, plaintext) {
    if (!this.k) return Buffer.from(plaintext)
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted')
    const out = seal(this.k, this.n, ad, plaintext)
    this.n += 1n
    return out
  }

  decrypt(ad, ciphertext) {
    if (!this.k) return Buffer.from(ciphertext)
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted')
    if (ciphertext.length < 16) throw new Error('ciphertext too short')
    const decipher = createDecipheriv('chacha20-poly1305', this.k, nonceBytes(this.n), { authTagLength: 16 })
    decipher.setAAD(ad, { plaintextLength: ciphertext.length - 16 })
    decipher.setAuthTag(ciphertext.subarray(-16))
    const out = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
    this.n += 1n
    return out
  }

  // REKEY keeps n, per Noise § 11.3.
  rekey() {
    this.k = seal(this.k, MAX_NONCE, EMPTY, Buffer.alloc(32)).subarray(0, 32)
  }
}

function seal(k, n, ad, plaintext) {
  const cipher = createCipheriv('chacha20-poly1305', k, nonceBytes(n), { authTagLength: 16 })
  cipher.setAAD(ad, { plaintextLength: plaintext.length })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

const PATTERNS = {
  XX: { pre: [[], []], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  XXpsk3: { pre: [[], []], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']] },
  KK: { pre: [['s'], ['s']], messages: [['e', 'es', 'ss'], ['e', 'ee', 'se']] },
}

export class HandshakeState {
  // `e` is a fixed ephemeral secret for vectors; production passes none and generates one per run.
  constructor({ pattern, initiator, prologue, s, rs = null, psk = null, e = null }) {
    this.pattern = PATTERNS[pattern]
    if (!this.pattern) throw new Error(`unknown pattern ${pattern}`)
    this.initiator = initiator
    this.hasPsk = pattern.includes('psk')
    this.s = s
    this.sPublic = x25519Public(s)
    this.rs = rs
    this.psk = psk
    this.fixedE = e
    this.e = null
    this.re = null
    this.cipher = new CipherState()
    const name = Buffer.from(`Noise_${pattern}_25519_ChaChaPoly_SHA256`, 'ascii')
    this.ck = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name)
    this.h = this.ck
    this.mixHash(prologue)
    const [initiatorPre, responderPre] = this.pattern.pre
    if (initiatorPre.includes('s')) this.mixHash(initiator ? this.sPublic : rs)
    if (responderPre.includes('s')) this.mixHash(initiator ? rs : this.sPublic)
    this.index = 0
  }

  mixHash(data) {
    this.h = sha256(this.h, data)
  }

  mixKey(ikm) {
    const [ck, k] = hkdf(this.ck, ikm, 2)
    this.ck = ck
    this.cipher = new CipherState(k)
  }

  mixKeyAndHash(ikm) {
    const [ck, th, k] = hkdf(this.ck, ikm, 3)
    this.ck = ck
    this.mixHash(th)
    this.cipher = new CipherState(k)
  }

  encryptAndHash(plaintext) {
    const out = this.cipher.encrypt(this.h, plaintext)
    this.mixHash(out)
    return out
  }

  decryptAndHash(ciphertext) {
    const out = this.cipher.decrypt(this.h, ciphertext)
    this.mixHash(ciphertext)
    return out
  }

  dhToken(token) {
    const [first, second] = token
    const initiatorKey = first === 'e' ? 'e' : 's'
    const responderKey = second === 'e' ? 'e' : 's'
    if (this.initiator) {
      return dh(initiatorKey === 'e' ? this.e.secret : this.s, responderKey === 'e' ? this.re : this.rs)
    }
    return dh(responderKey === 'e' ? this.e.secret : this.s, initiatorKey === 'e' ? this.re : this.rs)
  }

  get writing() {
    return (this.index % 2 === 0) === this.initiator
  }

  writeMessage(payload = EMPTY) {
    if (!this.writing) throw new Error('out of turn')
    const parts = []
    for (const token of this.pattern.messages[this.index]) {
      if (token === 'e') {
        const secret = this.fixedE ?? generateX25519().secret
        this.e = { secret, public: x25519Public(secret) }
        parts.push(this.e.public)
        this.mixHash(this.e.public)
        if (this.hasPsk) this.mixKey(this.e.public)
      } else if (token === 's') {
        parts.push(this.encryptAndHash(this.sPublic))
      } else if (token === 'psk') {
        this.mixKeyAndHash(this.psk)
      } else {
        this.mixKey(this.dhToken(token))
      }
    }
    parts.push(this.encryptAndHash(payload))
    this.index += 1
    return Buffer.concat(parts)
  }

  readMessage(message) {
    if (this.writing) throw new Error('out of turn')
    let rest = message
    const take = (length) => {
      if (rest.length < length) throw new Error('message too short')
      const head = rest.subarray(0, length)
      rest = rest.subarray(length)
      return head
    }
    for (const token of this.pattern.messages[this.index]) {
      if (token === 'e') {
        this.re = Buffer.from(take(32))
        this.mixHash(this.re)
        if (this.hasPsk) this.mixKey(this.re)
      } else if (token === 's') {
        this.rs = this.decryptAndHash(take(this.cipher.k ? 48 : 32))
      } else if (token === 'psk') {
        this.mixKeyAndHash(this.psk)
      } else {
        this.mixKey(this.dhToken(token))
      }
    }
    const payload = this.decryptAndHash(rest)
    this.index += 1
    return payload
  }

  get done() {
    return this.index === this.pattern.messages.length
  }

  // Noise's Split(): c1 carries initiator to responder, c2 the reverse.
  split() {
    if (!this.done) throw new Error('handshake not finished')
    const [k1, k2] = hkdf(this.ck, EMPTY, 2)
    const c1 = new CipherState(k1)
    const c2 = new CipherState(k2)
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 }
  }
}

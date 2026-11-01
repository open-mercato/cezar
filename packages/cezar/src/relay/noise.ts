import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';

/**
 * Noise revision 34 for 25519_ChaChaPoly_SHA256, over node:crypto (OpenSSL) only.
 *
 * Unaudited state machine, thin on purpose: no maintained library has XXpsk3, KK and Rekey
 * (RELAY_PROTOCOL.md § 16). Every primitive is OpenSSL's, and the shared vectors pin the rest.
 */

const EMPTY = Buffer.alloc(0);
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const MAX_NONCE = 0xffffffffffffffffn;

const privateKey = (raw: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const publicKey = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });

export const x25519Public = (secret: Buffer): Buffer =>
  Buffer.from(createPublicKey(privateKey(secret)).export({ format: 'der', type: 'spki' })).subarray(-32);

export function generateX25519(): { secret: Buffer; public: Buffer } {
  const { privateKey: generated } = generateKeyPairSync('x25519');
  const secret = Buffer.from(generated.export({ format: 'der', type: 'pkcs8' })).subarray(-32);
  return { secret, public: x25519Public(secret) };
}

// OpenSSL refuses a low-order peer key, which is the all-zero output the contract forbids.
const dh = (secret: Buffer, peer: Buffer): Buffer =>
  diffieHellman({ privateKey: privateKey(secret), publicKey: publicKey(peer) });

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Noise's HKDF(ck, ikm, n) is RFC 5869 with salt = ck and empty info. */
function hkdf(ck: Buffer, ikm: Buffer, outputs: number): Buffer[] {
  const okm = Buffer.from(hkdfSync('sha256', ikm, ck, EMPTY, 32 * outputs));
  return Array.from({ length: outputs }, (_, i) => okm.subarray(i * 32, (i + 1) * 32));
}

function nonceBytes(n: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

function seal(k: Buffer, n: bigint, ad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', k, nonceBytes(n), { authTagLength: 16 });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

export class CipherState {
  k: Buffer | null;
  n = 0n;

  constructor(k: Buffer | null = null) {
    this.k = k;
  }

  encrypt(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) return Buffer.from(plaintext);
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted');
    const out = seal(this.k, this.n, ad, plaintext);
    this.n += 1n;
    return out;
  }

  decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.k) return Buffer.from(ciphertext);
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted');
    if (ciphertext.length < 16) throw new Error('ciphertext too short');
    const decipher = createDecipheriv('chacha20-poly1305', this.k, nonceBytes(this.n), { authTagLength: 16 });
    decipher.setAAD(ad, { plaintextLength: ciphertext.length - 16 });
    decipher.setAuthTag(ciphertext.subarray(-16));
    const out = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    this.n += 1n;
    return out;
  }

  /** REKEY keeps n, per Noise § 11.3. */
  rekey(): void {
    if (!this.k) throw new Error('no key to rekey');
    this.k = seal(this.k, MAX_NONCE, EMPTY, Buffer.alloc(32)).subarray(0, 32);
  }
}

type PatternName = 'XXpsk3' | 'KK';

const PATTERNS: Record<PatternName, { preMessages: boolean; messages: string[][] }> = {
  XXpsk3: { preMessages: false, messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']] },
  KK: { preMessages: true, messages: [['e', 'es', 'ss'], ['e', 'ee', 'se']] },
};

export interface HandshakeOptions {
  pattern: PatternName;
  initiator: boolean;
  prologue: Buffer;
  s: Buffer;
  rs?: Buffer;
  psk?: Buffer;
  /** Fixed ephemeral secret, for the shared vectors and the testkit only. */
  fixedEphemeral?: Buffer;
}

export class HandshakeState {
  private readonly pattern: { preMessages: boolean; messages: string[][] };
  private readonly initiator: boolean;
  private readonly hasPsk: boolean;
  private readonly s: Buffer;
  private readonly sPublic: Buffer;
  private readonly psk: Buffer | undefined;
  private readonly fixedEphemeral: Buffer | undefined;
  private e: { secret: Buffer; public: Buffer } | null = null;
  private re: Buffer | null = null;
  private cipher = new CipherState();
  private ck: Buffer;
  private index = 0;
  h: Buffer;
  rs: Buffer | null;

  constructor(options: HandshakeOptions) {
    this.pattern = PATTERNS[options.pattern];
    this.initiator = options.initiator;
    this.hasPsk = options.pattern.includes('psk');
    this.s = options.s;
    this.sPublic = x25519Public(options.s);
    this.rs = options.rs ?? null;
    this.psk = options.psk;
    this.fixedEphemeral = options.fixedEphemeral;
    const name = Buffer.from(`Noise_${options.pattern}_25519_ChaChaPoly_SHA256`, 'ascii');
    this.ck = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
    this.h = this.ck;
    this.mixHash(options.prologue);
    if (this.pattern.preMessages) {
      if (!this.rs) throw new Error('KK needs the remote static key');
      this.mixHash(this.initiator ? this.sPublic : this.rs);
      this.mixHash(this.initiator ? this.rs : this.sPublic);
    }
  }

  private mixHash(data: Buffer): void {
    this.h = sha256(this.h, data);
  }

  private mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf(this.ck, ikm, 2) as [Buffer, Buffer];
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  private mixKeyAndHash(ikm: Buffer): void {
    const [ck, th, k] = hkdf(this.ck, ikm, 3) as [Buffer, Buffer, Buffer];
    this.ck = ck;
    this.mixHash(th);
    this.cipher = new CipherState(k);
  }

  private encryptAndHash(plaintext: Buffer): Buffer {
    const out = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(out);
    return out;
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const out = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return out;
  }

  private dhToken(token: string): Buffer {
    const first = token[0] === 'e';
    const second = token[1] === 'e';
    const localEphemeral = this.initiator ? first : second;
    const remoteEphemeral = this.initiator ? second : first;
    const local = localEphemeral ? this.e?.secret : this.s;
    const remote = remoteEphemeral ? this.re : this.rs;
    if (!local || !remote) throw new Error('handshake key missing');
    return dh(local, remote);
  }

  private get writing(): boolean {
    return (this.index % 2 === 0) === this.initiator;
  }

  private mixPsk(): void {
    if (!this.psk) throw new Error('handshake psk missing');
    this.mixKeyAndHash(this.psk);
  }

  writeMessage(payload: Buffer = EMPTY): Buffer {
    if (!this.writing || this.done) throw new Error('out of turn');
    const parts: Buffer[] = [];
    for (const token of this.pattern.messages[this.index]!) {
      if (token === 'e') {
        const secret = this.fixedEphemeral ?? generateX25519().secret;
        this.e = { secret, public: x25519Public(secret) };
        parts.push(this.e.public);
        this.mixHash(this.e.public);
        if (this.hasPsk) this.mixKey(this.e.public);
      } else if (token === 's') {
        parts.push(this.encryptAndHash(this.sPublic));
      } else if (token === 'psk') {
        this.mixPsk();
      } else {
        this.mixKey(this.dhToken(token));
      }
    }
    parts.push(this.encryptAndHash(payload));
    this.index += 1;
    return Buffer.concat(parts);
  }

  readMessage(message: Buffer): Buffer {
    if (this.writing || this.done) throw new Error('out of turn');
    let rest = message;
    const take = (length: number): Buffer => {
      if (rest.length < length) throw new Error('message too short');
      const head = rest.subarray(0, length);
      rest = rest.subarray(length);
      return head;
    };
    for (const token of this.pattern.messages[this.index]!) {
      if (token === 'e') {
        this.re = Buffer.from(take(32));
        this.mixHash(this.re);
        if (this.hasPsk) this.mixKey(this.re);
      } else if (token === 's') {
        this.rs = this.decryptAndHash(take(this.cipher.k ? 48 : 32));
      } else if (token === 'psk') {
        this.mixPsk();
      } else {
        this.mixKey(this.dhToken(token));
      }
    }
    const payload = this.decryptAndHash(rest);
    this.index += 1;
    return payload;
  }

  get done(): boolean {
    return this.index === this.pattern.messages.length;
  }

  /** Noise's Split(): c1 carries initiator to responder, c2 the reverse. */
  split(): { send: CipherState; receive: CipherState } {
    if (!this.done) throw new Error('handshake not finished');
    const [k1, k2] = hkdf(this.ck, EMPTY, 2) as [Buffer, Buffer];
    const c1 = new CipherState(k1);
    const c2 = new CipherState(k2);
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }
}

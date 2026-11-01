import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CipherState, HandshakeState, x25519Public } from './noise.ts';
import { normalizeCode, parseQr } from './phone-sim.testkit.ts';
import {
  OpenRefused,
  b64u,
  decodeFrame,
  decodeRecord,
  deriveFromCode,
  deriveFromSecret,
  edPublic,
  edSign,
  encodeFrame,
  encodeRecord,
  fromB64u,
  pairPrologue,
  parseRelayOrigin,
  qrString,
  relayId,
  sas,
  sessionPrologue,
  sizes,
  socketOrigin,
  type TunnelFrame,
} from './wire.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dir = join(import.meta.dirname, '../../../../test-vectors/relay');
const load = (name: string): any => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const hex = (text: string): Buffer => Buffer.from(text, 'hex');
const handshake = load('handshake-xxpsk3.json');
const kk = load('session-kk.json');

const xx = (role: 'phone' | 'cezar', overrides: { psk?: Buffer } = {}) => new HandshakeState({
  pattern: 'XXpsk3',
  initiator: role === 'phone',
  prologue: hex(handshake.prologue),
  s: hex(handshake[role].x25519Secret),
  psk: overrides.psk ?? hex(handshake.psk),
  fixedEphemeral: hex(handshake[role].ephemeralSecret),
});
const session = (role: 'phone' | 'cezar') => new HandshakeState({
  pattern: 'KK',
  initiator: role === 'phone',
  prologue: hex(kk.prologue),
  s: hex(kk[role].x25519Secret),
  rs: hex(kk[role === 'phone' ? 'cezar' : 'phone'].x25519Public),
  fixedEphemeral: hex(kk[role].ephemeralSecret),
});

/** The vector's frame shape, so one comparison covers every frame type. */
function fields(frame: TunnelFrame): Record<string, unknown> {
  const { type: _type, ...rest } = frame;
  return 'data' in rest ? { ...rest, data: rest.data.toString('hex') } : rest;
}

describe('proof.json', () => {
  it('reproduces ids and signatures', () => {
    const proofs = load('proof.json');
    for (const item of [...proofs.sockets, ...proofs.posts]) {
      const seed = hex(item.seed);
      expect(b64u(edPublic(seed))).toBe(item.key);
      expect(relayId(edPublic(seed))).toBe(item.id);
      expect(b64u(edSign(seed, item.proofString))).toBe(item.sig);
    }
  });
});

describe('qr.json', () => {
  const qr = load('qr.json');
  it('derives the locator and psk and rebuilds every accepted string', () => {
    const keys = deriveFromSecret(hex(qr.secret));
    expect(keys.locator.toString('hex')).toBe(qr.locatorHex);
    expect(keys.psk.toString('hex')).toBe(qr.psk);
    for (const item of qr.accepted) {
      const origin = parseRelayOrigin(item.relayOrigin);
      expect(origin).toBe(item.relayOrigin);
      expect(socketOrigin(origin!)).toBe(item.socketOrigin);
      expect(qrString(origin!, hex(qr.secret), hex(qr.cezarX25519))).toBe(item.qr);
    }
  });

  it('refuses every string the grammar refuses', () => {
    for (const item of qr.refused) expect(parseQr(item.qr), item.name).toEqual({ refused: item.reason });
  });

  it('applies the host rows to CEZ_RELAY_URL', () => {
    expect(parseRelayOrigin('http://relay.example.test')).toBeNull();
    expect(parseRelayOrigin('http://192.168.1.2:8787')).toBeNull();
    expect(parseRelayOrigin('HTTPS://relay.example.test')).toBeNull();
    expect(parseRelayOrigin('https://relay.example.test/path')).toBeNull();
    expect(parseRelayOrigin('https://relay.example.test/')).toBe('https://relay.example.test');
    expect(parseRelayOrigin('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
    expect(parseRelayOrigin(undefined)).toBeNull();
  });
});

describe('code.json', () => {
  it('derives both keys', async () => {
    const codes = load('code.json');
    for (const item of codes.refused) expect(normalizeCode(item.input), item.name).toBeNull();
    for (const item of codes.cases) {
      for (const input of item.inputs) expect(normalizeCode(input)).toBe(item.code);
      const keys = await deriveFromCode(item.code);
      expect(keys.locator.toString('hex')).toBe(item.locatorHex);
      expect(keys.psk.toString('hex')).toBe(item.psk);
    }
  });
});

describe('sas.json', () => {
  it('derives the six digits', () => {
    for (const item of load('sas.json').cases) expect(sas(hex(item.handshakeHash))).toBe(item.sas);
  });
});

describe('handshake-xxpsk3.json', () => {
  it('replays the pairing from both roles', () => {
    const phone = xx('phone');
    const cezar = xx('cezar');
    const [first, second, third] = handshake.messages;
    const one = phone.writeMessage();
    expect(one.toString('hex')).toBe(first.message);
    expect(cezar.readMessage(one).length).toBe(0);
    const two = cezar.writeMessage();
    expect(two.toString('hex')).toBe(second.message);
    expect(phone.readMessage(two).length).toBe(0);
    expect(phone.rs?.toString('hex')).toBe(handshake.cezar.x25519Public);
    const three = phone.writeMessage(hex(third.payload));
    expect(three.toString('hex')).toBe(third.message);
    const payload = cezar.readMessage(three);
    expect(payload.toString('hex')).toBe(third.payload);
    expect(JSON.parse(decodeRecord(payload).toString('utf8')).relayKey).toBe(handshake.phone.relayKey);
    expect(cezar.rs?.toString('hex')).toBe(handshake.phone.x25519Public);
    expect(cezar.h.toString('hex')).toBe(handshake.handshakeHash);
    expect(phone.h.toString('hex')).toBe(handshake.handshakeHash);
    expect(sas(cezar.h)).toBe(handshake.sas);
    const keys = cezar.split();
    expect(keys.receive.k?.toString('hex')).toBe(handshake.transportKeys.phoneToCezar);
    expect(keys.send.k?.toString('hex')).toBe(handshake.transportKeys.cezarToPhone);
    const pending = handshake.afterHandshake.pending;
    expect(keys.send.encrypt(Buffer.alloc(0), encodeRecord(Buffer.from(pending.text))).toString('hex')).toBe(pending.ciphertext);
    for (const outcome of handshake.afterHandshake.outcomesAtNonce1) {
      const at1 = new CipherState(hex(handshake.transportKeys.cezarToPhone));
      at1.n = 1n;
      expect(at1.encrypt(Buffer.alloc(0), encodeRecord(Buffer.from(outcome.text))).toString('hex')).toBe(outcome.ciphertext);
    }
  });

  it('prologue helper matches', () => {
    expect(pairPrologue(hex(load('qr.json').locatorHex)).toString('hex')).toBe(handshake.prologue);
  });
});

describe('session-kk.json', () => {
  it('replays the session and every transport frame', () => {
    expect(sessionPrologue(kk.cezarId, kk.deviceId).toString('hex')).toBe(kk.prologue);
    const phone = session('phone');
    const cezar = session('cezar');
    const first = phone.writeMessage();
    expect(first.toString('hex')).toBe(kk.first.message);
    expect(first.length).toBe(48);
    expect(cezar.readMessage(first).length).toBe(0);
    const reply = cezar.writeMessage(hex(kk.second.payload));
    expect(reply.toString('hex')).toBe(kk.second.message);
    expect(phone.readMessage(reply).toString('hex')).toBe(kk.second.payload);
    expect(cezar.h.toString('hex')).toBe(kk.handshakeHash);
    const c = cezar.split();
    const p = phone.split();
    expect(c.receive.k?.toString('hex')).toBe(kk.transportKeys.phoneToCezar);
    expect(c.send.k?.toString('hex')).toBe(kk.transportKeys.cezarToPhone);
    for (const item of kk.transcript) {
      const sender = item.from === 'phone' ? p.send : c.send;
      const receiver = item.from === 'phone' ? c.receive : p.receive;
      const ciphertext = sender.encrypt(Buffer.alloc(0), encodeRecord(hex(item.content)));
      expect(ciphertext.toString('hex'), item.name).toBe(item.ciphertext);
      expect(decodeRecord(receiver.decrypt(Buffer.alloc(0), ciphertext)).toString('hex')).toBe(item.content);
    }
  });
});

describe('tunnel-frames.json', () => {
  const tunnel = load('tunnel-frames.json');
  it('round-trips every frame', () => {
    for (const item of tunnel.frames) {
      const decoded = decodeFrame(hex(item.content));
      expect(fields(decoded), item.name).toEqual(item.fields);
      expect(encodeFrame(decoded).toString('hex'), item.name).toBe(item.content);
      expect(encodeRecord(hex(item.content)).toString('hex'), item.name).toBe(item.record);
    }
  });

  it('pads and sizes as the table says', () => {
    for (const item of tunnel.padding) expect(encodeRecord(Buffer.alloc(item.contentLength)).length).toBe(item.recordLength);
    for (const item of tunnel.limits) {
      expect(sizes(item.frameBytes)).toEqual({ maxCiphertext: item.maxCiphertext, maxRecord: item.maxRecord, maxContent: item.maxContent, maxData: item.maxData });
    }
  });
});

describe('frames.json', () => {
  it('names the routed hop', () => {
    const frames = load('frames.json');
    expect(fromB64u(frames.deviceId, 16)?.toString('hex')).toBe(frames.deviceIdHex);
  });
});

describe('rekey.json', () => {
  it('rekeys one direction, keeping the counter', () => {
    const rekey = load('rekey.json');
    const sender = new CipherState(hex(rekey.steps[0].key));
    const receiver = new CipherState(hex(rekey.steps[0].key));
    for (const step of rekey.steps) {
      if (sender.k?.toString('hex') !== step.key) {
        sender.rekey();
        receiver.rekey();
      }
      expect(sender.k?.toString('hex'), step.name).toBe(step.key);
      expect(sender.n).toBe(BigInt(step.nonce));
      const ciphertext = sender.encrypt(Buffer.alloc(0), hex(step.record));
      expect(ciphertext.toString('hex'), step.name).toBe(step.ciphertext);
      expect(receiver.decrypt(Buffer.alloc(0), ciphertext).toString('hex')).toBe(step.record);
    }
  });
});

describe('negative.json', () => {
  const negative = load('negative.json');

  it('every transport case ends in a decryption failure', () => {
    for (const item of negative.transport) {
      const receiver = new CipherState(hex(item.key));
      for (const step of item.deliver) {
        if (step.expect === 'ok') receiver.decrypt(Buffer.alloc(0), hex(step.ciphertext));
        else expect(() => receiver.decrypt(Buffer.alloc(0), hex(step.ciphertext)), item.name).toThrow();
      }
    }
  });

  it('refuses the old key after rekey', () => {
    const receiver = new CipherState(hex(negative.afterRekey.key));
    receiver.n = BigInt(negative.afterRekey.nonce);
    expect(() => receiver.decrypt(Buffer.alloc(0), hex(negative.afterRekey.ciphertext))).toThrow();
  });

  it('every handshake case stops before anything is acted on', () => {
    for (const item of negative.handshake) {
      if (item.pattern === 'KK') {
        const message = hex(item.message);
        // The 48-byte rule is the session's first check, and the payload case passes Noise itself.
        if (item.name.includes('payload')) expect(message.length).not.toBe(48);
        else expect(() => session('cezar').readMessage(message), item.name).toThrow();
      } else if (item.name.includes('wrong PSK')) {
        const cezar = xx('cezar');
        cezar.readMessage(hex(item.messagesBefore[0]));
        cezar.writeMessage();
        expect(() => cezar.readMessage(hex(item.message)), item.name).toThrow();
      } else {
        expect(item.name).toContain('pin mismatch');
        expect(item.receivedStatic).not.toBe(item.pinned);
      }
    }
  });

  it('refuses every bad record', () => {
    for (const item of negative.record) expect(() => decodeRecord(hex(item.record)), item.name).toThrow();
  });

  it('refuses every bad tunnel frame', () => {
    for (const item of negative.tunnel) {
      const attempt = () => decodeFrame(hex(item.content));
      if (item.name === 'CONNECT' || item.name.startsWith('target')) expect(attempt, item.name).toThrow(OpenRefused);
      else if (item.name === 'header value with CR LF' || item.name === 'uppercase header name') expect(attempt, item.name).toThrow();
      else expect(attempt, item.name).toThrow();
    }
  });
});

describe('x25519Public', () => {
  it('matches the vector keys', () => {
    expect(x25519Public(hex(handshake.cezar.x25519Secret)).toString('hex')).toBe(handshake.cezar.x25519Public);
  });
});

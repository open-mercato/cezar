import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface TlsMaterial {
  cert: string;
  key: string;
  fingerprint256: string;
  notAfter: Date;
}

// Length encoding for ASN.1 DER (short form if < 128, long form otherwise).
function encodeLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeTLV(tag: number, val: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(val.length), val]);
}

function encodeSequence(...items: Buffer[]): Buffer {
  return encodeTLV(0x30, Buffer.concat(items));
}

function encodeSet(...items: Buffer[]): Buffer {
  return encodeTLV(0x31, Buffer.concat(items));
}

// Encodes a dotted-decimal OID string to DER bytes.
function encodeOID(oidStr: string): Buffer {
  const parts = oidStr.split('.').map(Number);
  const bytes: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    const octets: number[] = [];
    octets.push(v & 0x7f);
    v >>= 7;
    while (v > 0) {
      octets.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.push(...octets);
  }
  return encodeTLV(0x06, Buffer.from(bytes));
}

// Dates before 2050 use UTCTime (tag 0x17); year 2050 and after use GeneralizedTime (tag 0x18).
function encodeTime(d: Date): Buffer {
  const year = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  if (year < 2050) {
    const yy = String(year % 100).padStart(2, '0');
    return encodeTLV(0x17, Buffer.from(`${yy}${m}${day}${h}${min}${s}Z`, 'ascii'));
  }
  const yyyy = String(year).padStart(4, '0');
  return encodeTLV(0x18, Buffer.from(`${yyyy}${m}${day}${h}${min}${s}Z`, 'ascii'));
}

function parseIPv4(ip: string): Buffer {
  return Buffer.from(ip.split('.').map((p) => parseInt(p, 10)));
}

function parseIPv6(ip: string): Buffer {
  let cleanIp = ip;
  let v4Buf: Buffer | null = null;
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    v4Buf = parseIPv4(tail);
    cleanIp = ip.slice(0, lastColon) + ':0:0';
  }
  const parts = cleanIp.split('::');
  let left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  let right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
  if (parts.length === 1) {
    left = cleanIp.split(':');
    right = [];
  }
  const fillZeros = 8 - (left.length + right.length);
  const allHextets = [...left, ...Array(fillZeros).fill('0'), ...right];
  const buf = Buffer.alloc(16);
  allHextets.forEach((h, idx) => {
    buf.writeUInt16BE(parseInt(h || '0', 16), idx * 2);
  });
  if (v4Buf) {
    v4Buf.copy(buf, 12);
  }
  return buf;
}

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Creates a self-signed X.509 v3 certificate and matching EC P-256 private key.
 */
export function createSelfSignedCert(opts: { hosts: string[]; days?: number; now?: Date }): { cert: string; key: string } {
  const days = opts.days ?? 365;
  const now = opts.now ?? new Date();

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // X.509 version 3: [0] EXPLICIT INTEGER 2
  const version = encodeTLV(0xa0, encodeTLV(0x02, Buffer.from([0x02])));

  // 16-byte random positive serial number (clear highest bit; ensure non-zero leading byte)
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] = (serialBytes[0]! & 0x7f) || 0x01;
  const serialNumber = encodeTLV(0x02, serialBytes);

  // ecdsa-with-SHA256 (OID 1.2.840.10045.4.3.2) without parameters
  const sigAlg = encodeSequence(encodeOID('1.2.840.10045.4.3.2'));

  // CN=cezar (local)
  const name = encodeSequence(
    encodeSet(
      encodeSequence(
        encodeOID('2.5.4.3'),
        encodeTLV(0x0c, Buffer.from('cezar (local)', 'utf8'))
      )
    )
  );

  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const validity = encodeSequence(encodeTime(notBefore), encodeTime(notAfter));

  const spki = publicKey.export({ type: 'spki', format: 'der' });

  // Extension 1: basicConstraints (2.5.29.19) critical CA:FALSE
  const basicConstraintsExt = encodeSequence(
    encodeOID('2.5.29.19'),
    encodeTLV(0x01, Buffer.from([0xff])),
    encodeTLV(0x04, encodeSequence(encodeTLV(0x01, Buffer.from([0x00]))))
  );

  // Extension 2: keyUsage (2.5.29.15) critical digitalSignature (bit 0)
  const keyUsageExt = encodeSequence(
    encodeOID('2.5.29.15'),
    encodeTLV(0x01, Buffer.from([0xff])),
    encodeTLV(0x04, encodeTLV(0x03, Buffer.from([0x07, 0x80])))
  );

  // Extension 3: extKeyUsage (2.5.29.37) serverAuth (1.3.6.1.5.5.7.3.1)
  const extKeyUsageExt = encodeSequence(
    encodeOID('2.5.29.37'),
    encodeTLV(0x04, encodeSequence(encodeOID('1.3.6.1.5.5.7.3.1')))
  );

  // Extension 4: subjectAltName (2.5.29.17)
  const sanEntries = opts.hosts.map((h) => {
    const ipVer = net.isIP(h);
    if (ipVer === 4) {
      return encodeTLV(0x87, parseIPv4(h));
    }
    if (ipVer === 6) {
      return encodeTLV(0x87, parseIPv6(h));
    }
    return encodeTLV(0x82, Buffer.from(h, 'ascii'));
  });
  const sanExt = encodeSequence(
    encodeOID('2.5.29.17'),
    encodeTLV(0x04, encodeSequence(...sanEntries))
  );

  const extensions = encodeTLV(0xa3, encodeSequence(basicConstraintsExt, keyUsageExt, extKeyUsageExt, sanExt));

  const tbs = encodeSequence(
    version,
    serialNumber,
    sigAlg,
    name,
    validity,
    name,
    spki,
    extensions
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const sigValue = encodeTLV(0x03, Buffer.concat([Buffer.from([0x00]), signature]));

  const certDer = encodeSequence(tbs, sigAlg, sigValue);
  const certPem = toPem(certDer, 'CERTIFICATE');
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  return { cert: certPem, key: keyPem };
}

function atomicWrite(targetPath: string, content: string, mode: number): void {
  const tmpPath = `${targetPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, { mode });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      // ignore
    }
  }
  fs.renameSync(tmpPath, targetPath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(targetPath, mode);
    } catch {
      // ignore
    }
  }
}

/**
 * Loads cached TLS certificate and key from dir, or generates a new pair if missing,
 * expiring within 30 days, mismatched, corrupted, or lacking required host coverage.
 */
export function loadOrCreateCert(dir: string, hosts: string[], now?: Date): TlsMaterial {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certPath = path.join(dir, 'cezar-cert.pem');
  const keyPath = path.join(dir, 'cezar-key.pem');

  let existingCertPem: string | null = null;
  let existingKeyPem: string | null = null;

  try {
    existingCertPem = fs.readFileSync(certPath, 'utf8');
    existingKeyPem = fs.readFileSync(keyPath, 'utf8');
  } catch {
    // Missing files; proceed to generation.
  }

  const currentTime = (now ?? new Date()).getTime();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  if (existingCertPem && existingKeyPem) {
    try {
      const cert = new crypto.X509Certificate(existingCertPem);
      const key = crypto.createPrivateKey(existingKeyPem);
      const matchesKey = cert.checkPrivateKey(key);
      const notAfter = new Date(cert.validTo);
      const expiresWellAfterNow = notAfter.getTime() - currentTime > THIRTY_DAYS_MS;
      const coversAllHosts = hosts.every((h) => {
        const isIp = net.isIP(h) !== 0;
        return isIp ? cert.checkIP(h) !== undefined : cert.checkHost(h) !== undefined;
      });

      if (matchesKey && expiresWellAfterNow && coversAllHosts) {
        return {
          cert: existingCertPem,
          key: existingKeyPem,
          fingerprint256: cert.fingerprint256,
          notAfter,
        };
      }
    } catch {
      // Corrupt or invalid existing files; fall through to regeneration.
    }
  }

  const generated = createSelfSignedCert({ hosts, now });
  atomicWrite(keyPath, generated.key, 0o600);
  atomicWrite(certPath, generated.cert, 0o644);

  const certObj = new crypto.X509Certificate(generated.cert);
  return {
    cert: generated.cert,
    key: generated.key,
    fingerprint256: certObj.fingerprint256,
    notAfter: new Date(certObj.validTo),
  };
}

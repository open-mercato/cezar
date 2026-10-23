import crypto from 'node:crypto';

function scryptAsync(
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

const HEX_REGEX = /^[0-9a-fA-F]+$/;

export interface PasswordHash {
  salt: string;
  hash: string;
}

/**
 * Derives an scrypt hash with a fresh 16-byte cryptographically secure random salt.
 */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, 64, SCRYPT_PARAMS)) as Buffer;
  return {
    salt: salt.toString('hex').toLowerCase(),
    hash: derivedKey.toString('hex').toLowerCase(),
  };
}

/**
 * Recomputes the scrypt hash with the stored salt and validates in constant time.
 * Returns false on malformed, non-hex, or mismatched inputs without throwing.
 */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (typeof password !== 'string') return false;
  if (!stored || typeof stored !== 'object') return false;
  if (typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
  // Salt must be exactly 16 bytes (32 hex characters) and hash 64 bytes (128 hex characters).
  if (stored.salt.length !== 32 || !HEX_REGEX.test(stored.salt)) return false;
  if (stored.hash.length !== 128 || !HEX_REGEX.test(stored.hash)) return false;

  try {
    const saltBuf = Buffer.from(stored.salt, 'hex');
    const storedHashBuf = Buffer.from(stored.hash, 'hex');
    const derivedKey = (await scryptAsync(password, saltBuf, 64, SCRYPT_PARAMS)) as Buffer;
    if (derivedKey.length !== storedHashBuf.length) return false;
    return crypto.timingSafeEqual(derivedKey, storedHashBuf);
  } catch {
    return false;
  }
}

/**
 * Parses HTTP Basic authorization header into username and password.
 * Decodes UTF-8 and splits on the first colon; returns null on invalid or missing credentials.
 */
export function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const b64 = match[1]!;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return null;

  return {
    username: decoded.slice(0, colonIdx),
    password: decoded.slice(colonIdx + 1),
  };
}

/**
 * Constant-time equality comparison between two strings by comparing their SHA-256 digests.
 */
export function safeEqualString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

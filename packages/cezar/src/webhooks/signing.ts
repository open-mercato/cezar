import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateSigningKey(): string { return 'whsec_' + randomBytes(32).toString('base64'); }
function decodeKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error('Invalid signing key');
  const bytes = Buffer.from(secret.slice(6), 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== secret.slice(6)) throw new Error('Invalid signing key');
  return bytes;
}
export function signWebhook(id: string, timestamp: number, body: string, secrets: readonly string[]): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !secrets.length || secrets.length > 2) throw new Error('Invalid signing input');
  return secrets.map(secret => 'v1,' + createHmac('sha256', decodeKey(secret)).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')).join(' ');
}
export function verifyWebhook(id: string, timestamp: number, body: string, signature: string, secrets: readonly string[], nowSeconds: number): boolean {
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300 || signature.length > 1024) return false;
  try {
    const expected = signWebhook(id, timestamp, body, secrets).split(' ').map(value => Buffer.from(value.slice(3), 'base64'));
    let valid = false;
    for (const part of signature.split(' ')) {
      if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(part)) continue;
      const received = Buffer.from(part.slice(3), 'base64');
      for (const candidate of expected) if (candidate.length === received.length && timingSafeEqual(candidate, received)) valid = true;
    }
    return valid;
  } catch { return false; }
}

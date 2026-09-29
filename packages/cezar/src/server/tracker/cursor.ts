import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TrackerRequestError } from './transport.ts';

/** Per-process signed cursor: restart expires it; the browser cannot choose an arbitrary endpoint. */
const secret = randomBytes(32);
const scopeHash = (scope: unknown): string => createHash('sha256').update(JSON.stringify(scope)).digest('hex');
export function encodeCursor(scope: unknown, position: string): string {
  const body = Buffer.from(JSON.stringify({ scope: scopeHash(scope), position })).toString('base64url');
  const cursor = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  if (cursor.length > 4096) throw new TrackerRequestError('invalid_response', 'Tracker pagination token exceeded the supported size. Narrow the request.');
  return cursor;
}
export function decodeCursor(scope: unknown, cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 4096) throw new Error();
    const [body, signature, extra] = cursor.split('.');
    if (!body || !signature || extra) throw new Error();
    const expected = createHmac('sha256', secret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('scope' in parsed) || parsed.scope !== scopeHash(scope) || !('position' in parsed) || typeof parsed.position !== 'string') throw new Error();
    return parsed.position;
  } catch { throw new TrackerRequestError('invalid_cursor', 'This result page expired or belongs to another search. Start the search again.'); }
}

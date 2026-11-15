import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { redactWebhookDiagnostics, retryAt } from './transport.ts';

const exec = promisify(execFile);
const now = 1700000000000;
const maxDate = 8_640_000_000_000_000;
const secret = 'syntheticRetryCredentialABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Real undici parser and streams; only DNS and socket routing are synthetic.
// Isolation also makes unhandled body disposal errors fail the child process.
const client = `
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  const net = require('node:net'), connect = net.connect;
  net.connect = function(options, ...rest) {
    return connect.call(this, { ...options, host: '127.0.0.1', port: Number(process.argv[2]), lookup: undefined }, ...rest);
  };
  const { sendWebhook, redactWebhookDiagnostics, retryAt } = await import(process.argv[1]);
  const result = await sendWebhook({
    url: 'http://receiver.invalid:' + process.argv[2] + '/', body: '{}', eventId: 'evt_retry',
    secrets: ['whsec_' + Buffer.alloc(32, 7).toString('base64')], diagnosticSecrets: [process.argv[3]],
    policy: { mode: 'local', allowLocalNetwork: false, serverPorts: [] },
  }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const results = [result, redactWebhookDiagnostics(result, []), redactWebhookDiagnostics(result, [], true)];
  console.log(JSON.stringify(results.map(result => ({ result,
    deadline: retryAt(1, ${now}, result.retryAfter, () => 0),
  }))));
`;

it.each([
  ['seconds', '60', now + 60000],
  ['date', new Date(now + 120000).toUTCString(), now + 120000],
  ['leading zeroes', '0'.repeat(300) + '60', now + 60000],
  ['fraction', '0'.repeat(300) + '60.5', now + 60500],
  ['below backoff', '0.5', now + 5000],
  ['huge', '9'.repeat(400), maxDate],
  ['beyond expiry', '0'.repeat(300) + '259201', now + 259201000],
  ['rfc850 date', 'Tuesday, 14-Nov-23 22:15:20 GMT', now + 120000],
  ['asctime date', 'Tue Nov 14 22:15:20 2023', now + 120000],
  ['asctime single day', 'Wed Nov  6 08:49:37 2024', Date.UTC(2024, 10, 6, 8, 49, 37)],
  ['invalid numeric suffix', '0'.repeat(254) + '60X', now + 5000],
  ['invalid false expiry', '9'.repeat(256) + 'X', now + 5000],
  ['invalid date suffix', new Date(now + 120000).toUTCString() + ' '.repeat(230) + 'X', now + 5000],
  ['invalid date false expiry', 'Sun, 14 Nov 9999 22:15:20 GMT' + ' '.repeat(230) + 'X', now + 5000],
  ['invalid obsolete hybrid', 'Tue, 14-Nov-2023 22:15:20 GMT', now + 5000],
  ['invalid calendar date', 'Fri, 31 Feb 2024 22:15:20 GMT', now + 5000],
  ['invalid clock', 'Tue, 14 Nov 2023 24:15:20 GMT', now + 5000],
  ['invalid date comment', new Date(now + 120000).toUTCString() + ' (ignored)', now + 5000],
  ['invalid', '60 ' + secret, now + 5000],
  ['invalid date', 'Wed, ' + secret, now + 5000],
  ['oversize', '0'.repeat(16384) + '60', now + 5000],
] as const)('preserves real HTTP retry timing through every diagnostic path: %s', async (name, header, deadline) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(429, { 'retry-after': header, 'content-type': 'text/plain' });
      response.end('safe ' + secret);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const { stdout, stderr } = await exec(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', client,
      new URL('./transport.ts', import.meta.url).href, String(port), secret,
    ], { timeout: process.platform === 'win32' ? 15_000 : 5_000 });
    expect(stderr).toBe('');
    const results = JSON.parse(stdout);
    for (const entry of results) {
      expect(entry.deadline).toBe(deadline);
      expect(JSON.stringify(entry.result)).not.toContain(secret);
      if (name === 'oversize') expect(entry.result).toEqual({ kind: 'transient', reason: 'connection_failed' });
      else expect(entry.result).toMatchObject({ kind: 'http', status: 429 });
    }
    if (name !== 'oversize') {
      expect(results[0].result.response).toBe('safe [REDACTED]');
      expect(results[2].result).not.toHaveProperty('response');
      expect(results[2].result).not.toHaveProperty('contentType');
      if (name.startsWith('invalid')) {
        expect(retryAt(1, now, header, () => 0)).toBe(now + 5000);
        for (const entry of results) {
          expect(entry.result).not.toHaveProperty('retryAfter');
          expect(entry.deadline).toBeLessThan(now + 72 * 3600000);
        }
      }
      else for (const entry of results) expect(entry.result.retryAfter).toBe(header);
    }
    if (name === 'beyond expiry' || name === 'huge') {
      // The service fails expired deliveries when next >= expiry; it must not
      // receive a clipped early deadline that permits another attempt instead.
      for (const entry of results) expect(entry.deadline).toBeGreaterThanOrEqual(now + 72 * 3600000);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, process.platform === 'win32' ? 20_000 : 10_000);

it('preserves bounded timing even when it overlaps redaction values, but rejects oversized input', () => {
  for (const omitText of [false, true]) {
    for (const value of ['0'.repeat(16381) + '60', new Date(now + 120000).toUTCString()]) {
      const result = redactWebhookDiagnostics({ kind: 'http', status: 429, retryAfter: value }, [value], omitText);
      expect(result).toEqual({ kind: 'http', status: 429, retryAfter: value });
    }
    expect(redactWebhookDiagnostics({ kind: 'http', status: 429, retryAfter: '0'.repeat(16382) + '60' }, [], omitText))
      .toEqual({ kind: 'http', status: 429 });
  }
});

it('interprets obsolete two-digit years relative to the scheduler clock', () => {
  // JS Date.parse uses a fixed 1950/2050 pivot, unlike HTTP's rolling 50 years.
  const reference = Date.UTC(2023, 10, 14, 22, 13, 20);
  expect(retryAt(1, reference, 'Tuesday, 14-Nov-60 22:15:20 GMT', () => 0)).toBe(Date.UTC(2060, 10, 14, 22, 15, 20));
  expect(retryAt(1, Date.UTC(1990, 0, 1), 'Tuesday, 14-Nov-20 22:15:20 GMT', () => 0)).toBe(Date.UTC(2020, 10, 14, 22, 15, 20));
  expect(retryAt(1, reference, 'Tuesday, 14-Nov-74 22:15:20 GMT', () => 0)).toBe(reference + 5000);
});

it('applies the header bound to direct scheduler inputs too', () => {
  expect(retryAt(1, now, '9'.repeat(16383), () => 0)).toBe(maxDate);
  expect(retryAt(1, now, '9'.repeat(16384), () => 0)).toBe(now + 5000);
});

it.each(['60\n', 'Tue, 14 Nov 2023 22:15:20 GMT\n'])('rejects line endings even on direct input: %j', value => {
  expect(retryAt(1, now, value, () => 0)).toBe(now + 5000);
  for (const omit of [false, true]) {
    expect(redactWebhookDiagnostics({ kind: 'http', status: 429, retryAfter: value }, [], omit)).not.toHaveProperty('retryAfter');
  }
});

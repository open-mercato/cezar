import { afterEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ options: undefined as any, request: vi.fn(), destroy: vi.fn(async () => undefined) }));
vi.mock('undici', () => ({ Agent: class { constructor(options: any) { wire.options = options; } destroy = wire.destroy; }, request: wire.request }));
import * as transport from './transport.ts';
import { verifyWebhook } from './signing.ts';
const input = () => ({ url: 'https://example.com/private?token=hidden', body: '{"test":true}', eventId: 'evt_test', secrets: ['whsec_' + Buffer.alloc(32, 7).toString('base64')], policy: { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [4317] } });
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
function response(text: string, statusCode = 200) {
  return { statusCode, headers: { 'content-type': 'text/plain', 'retry-after': '60' }, body: Object.assign((async function* () { yield Buffer.from(text); })(), { once: () => undefined, destroy: () => undefined }) };
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('bounded webhook transport', () => {
  it('pins a validated IP and secure dedicated dispatcher regardless of environment', async () => {
    for (const [key, value] of Object.entries({ HTTP_PROXY: 'http://proxy.invalid', HTTPS_PROXY: 'http://proxy.invalid', NO_PROXY: '*', NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' })) vi.stubEnv(key, value);
    wire.request.mockResolvedValue(response('ok'));
    const result = await transport.sendWebhook({ ...input(), url: 'https://example.com/' }, { lookup, now: () => 1700000000000 });
    expect(result).toMatchObject({ kind: 'http', status: 200, response: 'ok' });
    expect(wire.options.connect.autoSelectFamily).toBe(false); expect(wire.options.connect.rejectUnauthorized).toBe(true);
    const actual = await new Promise(resolve => wire.options.connect.lookup('example.com', {}, (_: unknown, address: string) => resolve(address)));
    expect(actual).toBe('8.8.8.8');
    const options = wire.request.mock.calls[0]![1];
    expect(options.maxRedirections).toBe(0);
    expect(verifyWebhook('evt_test', 1700000000, input().body, options.headers['webhook-signature'], input().secrets, 1700000000)).toBe(true);
  });
  it('discards private response bodies and limit-reaching public diagnostics', async () => {
    wire.request.mockResolvedValue(response('internal secret'));
    const privateResult = await transport.sendWebhook({ ...input(), url: 'http://127.0.0.1:9090/', policy: { ...input().policy, allowLocalNetwork: true } });
    expect(privateResult).toEqual({ kind: 'http', status: 200, contentType: 'text/plain', retryAfter: '60' });
    wire.request.mockResolvedValue(response('x'.repeat(10_000)));
    const publicResult = await transport.sendWebhook({ ...input(), url: 'https://example.com/' }, { lookup });
    expect(publicResult.kind).toBe('http');
    expect(publicResult).not.toHaveProperty('response');
  });
  it('omits untrusted diagnostics for destinations with path or query credentials', async () => {
    for (const url of ['https://example.com/hooks/fake%2Fcredential?token=abc', 'https://example.com/?token=x', 'https://example.com/a']) {
      wire.request.mockResolvedValue(response('Cannot POST /hooks/fake/credential token=abc x a', 404));
      const result = await transport.sendWebhook({ ...input(), url }, { lookup });
      expect(result).toMatchObject({ kind: 'http', status: 404 });
      expect(result).not.toHaveProperty('response');
    }
  });
  it('keeps huge numeric Retry-After Date-safe without falling back to an early retry', () => {
    const now = 1700000000000;
    for (const value of ['99999999999999', '9'.repeat(256), '9'.repeat(400)]) {
      const at = transport.retryAt(1, now, value, () => 0);
      expect(Number.isFinite(at)).toBe(true);
      expect(() => new Date(at).toISOString()).not.toThrow();
      expect(at).toBeGreaterThan(now + 72 * 3600000);
    }
  });
  it('returns safe policy/connection failures without URL paths or raw errors', async () => {
    expect(await transport.sendWebhook({ ...input(), url: 'http://169.254.169.254/private' })).toEqual({ kind: 'policy', reason: 'denied_address' });
    wire.request.mockRejectedValue(new Error('failure at https://example.com/private?token=hidden'));
    expect(await transport.sendWebhook(input(), { lookup })).toEqual({ kind: 'transient', reason: 'connection_failed' });
  });
  it('bounds DNS by the same total deadline as HTTP', async () => {
    vi.useFakeTimers();
    try {
      const result = transport.sendWebhook(input(), { lookup: () => new Promise(() => undefined) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toEqual({ kind: 'transient', reason: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
  it('honors seconds/date Retry-After and never schedules earlier than backoff', () => {
    const now = 1700000000000;
    expect(transport.retryAt(1, now, '60', () => 0)).toBe(now + 60000);
    expect(transport.retryAt(1, now, new Date(now + 120000).toUTCString(), () => 0)).toBe(now + 120000);
    expect(transport.retryAt(1, now, '-1', () => 0)).toBe(now + 5000);
    expect(transport.retryAt(100, now, undefined, () => 1)).toBe(now + 3600000);
  });
});

describe('chat transport', () => {
  const slack = 'https://hooks.slack.com/services/T1/B1/test';
  const discord = `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(68)}`;
  it.each([['slack.v1', slack, 'channel_is_archived'], ['discord.v1', discord, '{"code":10015,"message":"Unknown Webhook"}']] as const)('omits signature headers for %s and retains safe diagnostics', async (format, url, body) => {
    wire.request.mockResolvedValue(response(body, 404));
    const result = await transport.sendWebhook({ ...input(), url, format }, { lookup });
    expect(result).toMatchObject({ kind: 'http', status: 404, response: body });
    expect(Object.keys(wire.request.mock.calls[0]![1].headers).some(key => key.startsWith('webhook-'))).toBe(false);
    if (format === 'discord.v1') expect(result).toHaveProperty('providerCode', 10015);
  });
  it('requests Discord persistence confirmation without retaining the returned message', async () => {
    wire.request.mockResolvedValue(response(JSON.stringify({ id: '123', content: 'private task text', embeds: [{ title: 'private title' }] })));
    const result = await transport.sendWebhook({ ...input(), url: discord, format: 'discord.v1' }, { lookup });
    expect(String(wire.request.mock.calls[0]![0])).toBe(`${discord}?wait=true`);
    expect(result).toMatchObject({ kind: 'http', status: 200 });
    expect(result).not.toHaveProperty('response');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([['slack.v1', slack], ['cezar.json.v1', discord], ['cezar.json.v1', 'https://example.com/hook?wait=false']] as const)('preserves the URL for %s', async (format, url) => {
    wire.request.mockResolvedValue(response('ok'));
    await transport.sendWebhook({ ...input(), url, format }, { lookup });
    expect(String(wire.request.mock.calls[0]![0])).toBe(url);
  });
  it('drops echoes and extra Discord properties, retaining only a bounded provider code and vocabulary', async () => {
    wire.request.mockResolvedValue(response(JSON.stringify({ code: 50027, message: 'secret url token', secret: 'hidden' }), 401));
    expect(await transport.sendWebhook({ ...input(), url: discord, format: 'discord.v1' }, { lookup })).toMatchObject({ providerCode: 50027, response: '{"code":50027}' });
    for (const body of ['secret_token_echo', 'x'.repeat(65)]) {
      wire.request.mockResolvedValue(response(body));
      expect(await transport.sendWebhook({ ...input(), url: slack, format: 'slack.v1' }, { lookup })).not.toHaveProperty('response');
    }
    wire.request.mockResolvedValue(response('{"code":10015,"padding":"' + 'x'.repeat(512) + '"}', 404));
    expect(await transport.sendWebhook({ ...input(), url: discord, format: 'discord.v1' }, { lookup })).not.toHaveProperty('providerCode');
  });
  it('never enables provider diagnostics for a custom endpoint', async () => {
    wire.request.mockResolvedValue(response('{"code":10015}', 404));
    expect(await transport.sendWebhook({ ...input(), format: 'discord.v1' }, { lookup })).not.toHaveProperty('providerCode');
  });
  it('keeps protocol codes through late diagnostic redaction', () => {
    expect(transport.redactWebhookDiagnostics({ kind: 'http', status: 404, providerCode: 10015, response: 'discard' }, [], true)).toEqual({ kind: 'http', status: 404, providerCode: 10015 });
  });
});

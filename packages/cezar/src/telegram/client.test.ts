import { afterEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ request: vi.fn(), options: undefined as any, agents: 0 }));
vi.mock('undici', () => ({ Agent: class { constructor(options: any) { wire.options = options; wire.agents++; } async destroy() {} async close() {} }, request: wire.request }));
import { telegramClient } from './client.ts';
const options = { token: async () => '123456789:' + 'A'.repeat(35), policy: { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [] }, lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
function response(value: unknown, statusCode = 200) {
  return { statusCode, body: Object.assign((async function* () { yield Buffer.from(JSON.stringify(value)); })(), { destroy() {} }) };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe('Telegram inbound transport', () => {
  it('uses fixed host, public pinned DNS, no redirects and the long poll deadline', async () => {
    wire.request.mockResolvedValue(response({ ok: true, result: [] }));
    expect(await telegramClient(options)('getUpdates', { timeout: 25 })).toEqual([]);
    expect(String(wire.request.mock.calls[0]?.[0])).toMatch(/^https:\/\/api.telegram.org\/bot/);
    expect(wire.request.mock.calls[0]?.[1]).toMatchObject({ maxRedirections: 0, headersTimeout: 35_000 });
    expect(wire.options.connect.rejectUnauthorized).toBe(true);
    const address = await new Promise(resolve => wire.options.connect.lookup('api.telegram.org', {}, (_error: unknown, address: string) => resolve(address)));
    expect(address).toBe('8.8.8.8');
  });
  it('does no networking in dry-run without a simulation transport', async () => {
    await expect(telegramClient({ ...options, dryRun: true })('getUpdates', {})).rejects.toMatchObject({ code: 'policy' });
    expect(wire.request).not.toHaveBeenCalled();
  });
  it('preserves long retry_after without exposing provider error text', async () => {
    wire.request.mockResolvedValue(response({ ok: false, description: 'private token', parameters: { retry_after: 3600 } }, 429));
    await expect(telegramClient(options)('getUpdates', {})).rejects.toMatchObject({ status: 429, retryAfter: 3600, message: 'Telegram request failed: http' });
  });
  it('bounds DNS and respects parent cancellation', async () => {
    vi.useFakeTimers();
    const promise = telegramClient({ ...options, lookup: () => new Promise(() => {}) })('getUpdates', {});
    const assertion = expect(promise).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(35_000); await assertion;
    const controller = new AbortController(); controller.abort();
    await expect(telegramClient(options)('getMe', {}, controller.signal)).rejects.toMatchObject({ code: 'network' });
  });
  it('rejects an oversized body', async () => {
    wire.request.mockResolvedValue(response({ ok: true, result: 'x'.repeat(1024 * 1024) }));
    await expect(telegramClient(options)('getUpdates', {})).rejects.toMatchObject({ code: 'body_limit' });
  });
});
it('aborts a stalled response body at the request deadline', async () => {
  vi.useFakeTimers(); const destroy = vi.fn();
  wire.request.mockResolvedValue({ statusCode: 200, body: { destroy, [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } } });
  const pending = telegramClient(options)('getMe', {});
  const rejected = expect(pending).rejects.toMatchObject({ code: 'network' });
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(destroy).toHaveBeenCalled();
});
it('reuses one pooled connection agent per pinned address', async () => {
  wire.request.mockImplementation(async () => response({ ok: true, result: true }));
  const pinned = { ...options, lookup: async () => [{ address: '8.8.4.4', family: 4 }] }, before = wire.agents;
  await telegramClient(pinned)('getMe', {}); await telegramClient(pinned)('sendMessage', {}); await telegramClient(pinned)('getUpdates', {});
  expect(wire.agents - before).toBe(1);
  expect(wire.request.mock.calls.map(call => call[1].dispatcher)).toEqual(Array(3).fill(wire.request.mock.calls[0]![1].dispatcher));
  await telegramClient({ ...options, lookup: async () => [{ address: '1.1.1.1', family: 4 }] })('getMe', {});
  expect(wire.agents - before).toBe(2);
});

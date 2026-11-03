import { afterEach, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ request: vi.fn() }));
// Replace only the socket boundary; dispatcher, token/DNS preparation and client remain real.
vi.mock('undici', () => ({ Agent: class { async close() {} }, request: wire.request }));
import { telegramClient } from './client.ts';
import { TelegramReplies } from './dispatcher.ts';

const token = '123456789:' + 'A'.repeat(35);
const addresses = [{ address: '8.8.8.8', family: 4 }];
const policy = { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function response() {
  return { statusCode: 200, body: Object.assign((async function* () {
    yield Buffer.from(JSON.stringify({ ok: true, result: { message_id: 77 } }));
  })(), { destroy() {} }) };
}
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

it.each(['token', 'DNS'] as const)('drops revoked replies held at %s resolution permanently while another chat continues', async barrier => {
  vi.useFakeTimers();
  const entered = deferred<void>(), release = deferred<void>();
  let valid = true, first = true;
  const pause = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const tokenRead = vi.fn(async () => { if (barrier === 'token') await pause(); return token; });
  const lookup = vi.fn(async () => { if (barrier === 'DNS') await pause(); return addresses; });
  wire.request.mockImplementation(async () => response());
  const replies = new TelegramReplies(telegramClient({ token: tokenRead, policy, lookup }));
  const sent = vi.fn(async () => {}), failed = vi.fn(async () => {}), settled = vi.fn();
  const otherSent = vi.fn(async () => {});
  try {
    replies.deliver('123', 'Private task question', { valid: () => valid, sent, failed, settled });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    expect(wire.request).not.toHaveBeenCalled();
    valid = false;
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(wire.request).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    replies.deliver('456', 'Still authorized', { valid: () => true, sent: otherSent });
    await vi.advanceTimersByTimeAsync(5000);
    expect(wire.request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(wire.request.mock.calls[0]![1].body)).toMatchObject({ chat_id: '456', text: 'Still authorized' });
    expect(otherSent).toHaveBeenCalledWith({ message_id: 77 });
    expect(tokenRead).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); await replies.stop(); }
});

it('does not recall an HTTP request already started, but suppresses its receipt after revocation', async () => {
  vi.useFakeTimers();
  const entered = deferred<void>(), release = deferred<void>();
  let valid = true;
  wire.request.mockImplementation(async () => { entered.resolve(); await release.promise; return response(); });
  const replies = new TelegramReplies(telegramClient({ token: async () => token, policy, lookup: async () => addresses }));
  const sent = vi.fn(async () => {}), settled = vi.fn();
  try {
    replies.deliver('123', 'Authorized at HTTP start', { valid: () => valid, sent, settled });
    await vi.advanceTimersByTimeAsync(0); await entered.promise;
    expect(wire.request).toHaveBeenCalledTimes(1);
    valid = false; release.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(wire.request).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); await replies.stop(); }
});

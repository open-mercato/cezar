import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelegramPoller } from './poller.ts';
import { TelegramApiError } from './client.ts';
import { freshState, InboundStateStore } from './state.ts';

function fixture() {
  const state = freshState('123', { projectId: 'project', installationId: 'instance', root: '/root', generation: randomUUID() });
  return new InboundStateStore(state, { assertOwner() {}, async write() {} });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
describe('Telegram single consumer poller', () => {
  it('persists progress before confirming it and does not update lastUpdateAt for empty polls', async () => {
    const store = fixture(); let needed = true;
    const call = vi.fn().mockResolvedValueOnce([{ update_id: 12 }]).mockResolvedValueOnce([]).mockImplementationOnce(async () => { needed = false; return []; });
    const poller = new TelegramPoller({ store, call, needed: () => needed, assertCredentials: async () => {}, now: () => 1000,
      process: update => store.finish(store.snapshot().epoch, update.update_id) });
    poller.start(); await tick();
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty('offset');
    expect(call.mock.calls[1]?.[1]).toHaveProperty('offset', 13);
    expect(store.snapshot().lastUpdateAt).toBe(1000);
    await poller.stop();
  });
  it('retries oversized batch at limit one then blocks without confirming', async () => {
    const store = fixture(), call = vi.fn().mockRejectedValue(new TelegramApiError('body_limit'));
    const poller = new TelegramPoller({ store, call, needed: () => true, assertCredentials: async () => {}, process: async () => {} });
    poller.start(); await tick();
    expect(call).toHaveBeenCalledTimes(2); expect(call.mock.calls[1]?.[1]).toHaveProperty('limit', 1);
    expect(store.snapshot().nextOffset).toBeNull(); expect(poller.health().state).toBe('blocked');
    await poller.stop();
  });
  it('respects long retry_after and aborts sleep on stop', async () => {
    const store = fixture(), call = vi.fn().mockRejectedValue(new TelegramApiError('http', 429, 3600));
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
    const poller = new TelegramPoller({ store, call, needed: () => true, assertCredentials: async () => {}, process: async () => {}, wait, now: () => 0 });
    poller.start(); await tick();
    expect(wait.mock.calls[0]?.[0]).toBe(3600_000); expect(call).toHaveBeenCalledTimes(1);
    await poller.stop();
  });
  it.each([new TelegramApiError('http', 500), new TelegramApiError('http', 503), new TelegramApiError('network')])
    ('backs off transient provider/DNS failures (%s)', async error => {
      const wait = vi.fn(async (_ms: number, signal: AbortSignal) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      });
      const poller = new TelegramPoller({ store: fixture(), call: vi.fn().mockRejectedValue(error), needed: () => true,
        assertCredentials: async () => {}, process: async () => {}, wait, now: () => 0 });
      poller.start(); await tick();
      expect(poller.health().state).toBe('backoff'); expect(wait).toHaveBeenCalledWith(expect.any(Number), expect.any(AbortSignal));
      await poller.stop();
    });
  it('never retries provider conflict', async () => {
    const call = vi.fn().mockRejectedValue(new TelegramApiError('http', 409));
    const poller = new TelegramPoller({ store: fixture(), call, needed: () => true, assertCredentials: async () => {}, process: async () => {} });
    poller.start(); await tick(); expect(call).toHaveBeenCalledTimes(1); expect(poller.health().state).toBe('conflict'); await poller.stop();
  });
  it('does not poll when credential validation fails', async () => {
    const call = vi.fn();
    const poller = new TelegramPoller({ store: fixture(), call, needed: () => true, assertCredentials: async () => { throw new Error('missing'); }, process: async () => {} });
    poller.start(); await tick(); expect(call).not.toHaveBeenCalled(); expect(poller.health().state).toBe('credentials-unavailable'); await poller.stop();
  });
});
it('writes once per batch of ignored updates instead of once per update', async () => {
  const state = freshState('123', { projectId: 'project', installationId: 'instance', root: '/root', generation: randomUUID() });
  let writes = 0, base = 0, needed = true;
  const store = new InboundStateStore(state, { assertOwner() {}, async write() { writes++; } });
  const call = vi.fn().mockImplementationOnce(async () => { base = writes; return [1, 2, 3, 4, 5].map(update_id => ({ update_id })); })
    .mockImplementationOnce(async () => { needed = false; return []; });
  const poller = new TelegramPoller({ store, call, needed: () => needed, assertCredentials: async () => {}, now: () => 1000,
    process: update => store.finish(store.snapshot().epoch, update.update_id) });
  poller.start(); await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2)); await poller.stop();
  expect(writes - base).toBe(1); expect(store.snapshot()).toMatchObject({ nextOffset: 6, lastUpdateAt: 1000 });
});

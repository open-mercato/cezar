import { describe, expect, it, vi } from 'vitest';
import { ChatExtensionBridge } from './chat-bridge.ts';
import { receiveRetryDelay } from '../chat/connection.ts';
import { ChatTransportError } from '../chat/provider.ts';

const identity = { id: 'bot-1', username: 'test-bot' };
const receipt = { chatId: 'room-1', messageId: 'message-1' };
const journal = () => ({ recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'fixture', nextOffset: null }),
  duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {} });

describe('chat extension bridge', () => {
  it('preserves pairingEligible while mapping a public SDK message into the core', async () => {
    const accept = vi.fn(async () => {})
    const event = { kind: 'message', id: 'event-1', messageId: 'message-1', chat: { id: 'room-1', kind: 'private' as const },
      user: { id: 'person-1', label: 'Person' }, at: 1, text: '/start code', addressed: true, pairingEligible: false }
    const bridge = new ChatExtensionBridge(async (_operation, _input, options) => {
      await options.service!('accept', { kind: 'event', event })
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
    }, () => true, 'opaque')
    const connection = bridge.connect(journal(), { accept, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: () => {} })
    try { connection.start(); await expect.poll(() => accept.mock.calls.length).toBe(1) } finally { await connection.stop() }
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ pairingEligible: false }))
  })
  it('serializes the public operations and preserves opaque receipts', async () => {
    const invoke = vi.fn(async (operation: string, _input: unknown) => {
      if (operation === 'identify') return identity;
      if (operation === 'send') return receipt;
      return undefined;
    });
    const bridge = new ChatExtensionBridge(invoke, () => true, 'ordered');
    await expect(bridge.identify()).resolves.toEqual(identity);
    await expect(bridge.send('room-1', { text: 'hello' })).resolves.toEqual(receipt);
    expect(invoke).toHaveBeenNthCalledWith(1, 'identify', {}, expect.objectContaining({valid:expect.any(Function)}));
    expect(invoke).toHaveBeenNthCalledWith(2, 'send', { chatId: 'room-1', message: { text: 'hello' } }, expect.objectContaining({valid:expect.any(Function)}));
  });

  it('fences disabled adapters before and after an async wire call', async () => {
    let enabled = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn(async () => { await pending; return receipt; });
    const bridge = new ChatExtensionBridge(invoke, () => enabled, 'ordered');
    const send = bridge.send('room-1', { text: 'hello' });
    enabled = false;
    release();
    await expect(send).rejects.toMatchObject({ failure: { kind: 'blocked' } });
    await expect(bridge.send('room-1', { text: 'again' })).rejects.toMatchObject({ failure: { kind: 'blocked' } });
  });

  it('maps extension failures to the core transport vocabulary', async () => {
    const bridge = new ChatExtensionBridge(async () => { throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs: 250 }); }, () => true, 'ordered');
    await expect(bridge.send('room-1', { text: 'hello' })).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 250 } });
  });
});

it('backs off a persistently failing receive exponentially, capped at a minute (M3)', async () => {
  vi.useFakeTimers()
  const at: number[] = []
  const bridge = new ChatExtensionBridge(async () => { at.push(Date.now()); throw new ChatTransportError({ kind: 'transient' }) }, () => true, 'ordered')
  const connection = bridge.connect(journal(), { accept: async () => {}, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: () => {} })
  try {
    connection.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const gaps = at.slice(1).map((time, index) => time - at[index]!)
    expect(gaps.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000])
    expect(Math.max(...gaps)).toBe(60000)
  } finally { await connection.stop(); vi.useRealTimers() }
})

it('keeps a rate limit at its requested wait', () => {
  expect(receiveRetryDelay({ kind: 'rate_limited', retryAfterMs: 5000 }, 9)).toBe(5000)
  expect(receiveRetryDelay({ kind: 'transient' }, 30)).toBe(60000)
})

it('retains explicit host rendering through transport guards without upgrading ordinary text', async () => {
  const invoke = vi.fn(async () => receipt)
  const bridge = new ChatExtensionBridge(invoke, () => true, 'ordered', 'telegram-html')
  await bridge.guarded(() => true).send('room-1', { text: '<b>safe</b> &amp; escaped' })
  expect(invoke).toHaveBeenCalledWith('send', { chatId: 'room-1', message: { text: '<b>safe</b> &amp; escaped', textFormat: 'telegram-html' } }, expect.anything())
})

it('retries a receive session that ended without a ChatFailure (worker stopped, RPC timeout)', async () => {
  vi.useFakeTimers()
  try {
    let calls = 0
    const bridge = new ChatExtensionBridge(async (_operation, _input, options) => {
      if (++calls === 1) throw new Error('extension stopped')
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
    }, () => true, 'opaque')
    const health: string[] = []
    const connection = bridge.connect(journal(),
    { accept: async () => {}, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: value => { health.push(value.state) } })
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.health()).toEqual({ state: 'backoff' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
    expect(health).not.toContain('blocked')
    await connection.stop()
  } finally { vi.useRealTimers() }
})

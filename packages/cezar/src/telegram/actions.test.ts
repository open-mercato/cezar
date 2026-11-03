import { TelegramSendBudget } from './send-budget.ts';
import { TelegramApiError } from './client.ts';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelegramActions } from './actions.ts';
import { freshState, InboundStateStore } from './state.ts';
import type { TelegramUpdate } from './protocol.ts';

function fixture() {
  let now = 1000, valid = true, failWrite = false;
  const initial = freshState('123', { projectId: 'project', installationId: 'instance', root: '/repo', generation: randomUUID() });
  let disk = structuredClone(initial);
  const state = new InboundStateStore(initial, { assertOwner() {}, async write(next) {
    if (failWrite) throw new Error('write failed'); disk = structuredClone(next);
  }, now: () => now });
  const call = vi.fn(async () => ({})), reply = vi.fn();
  const execute = vi.fn(async (check: () => string | undefined) => {
    expect(disk.journal.at(-1)?.state).toBe('claimed'); return !check();
  });
  const actions = new TelegramActions({ botId: '123', state, call, reply, now: () => now });
  const preview = () => ({ kind: 'continue' as const, receiverId: 'receiver', chatId: '456', userId: '456', runId: 'task', valid: () => valid, execute });
  const create = async () => {
    const pending = actions.create(preview())!;
    await pending.sent({ message_id: 77, chat: { id: 456 } }); return pending;
  };
  const update = (data: string, id = 1): TelegramUpdate => ({ update_id: id, callback_query: {
    id: `callback-${id}`, data, from: { id: 456, is_bot: false }, message: { message_id: 77, chat: { id: 456, type: 'private' } },
  } });
  return { actions, create, preview, update, state, call, reply, execute, disk: () => disk,
    expire: () => { now += 120_000; }, revoke: () => { valid = false; }, fail: () => { failWrite = true; } };
}
describe('one-time Telegram task confirmations', () => {
  it('claims durably before effect and consumes different update IDs before first await', async () => {
    const x = fixture(), pending = await x.create(), epoch = x.state.snapshot().epoch;
    expect(pending.data).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The poller serializes updates; a second click with another ID still cannot repeat the effect.
    await x.actions.process(x.update(pending.data), epoch);
    await x.actions.process(x.update(pending.data, 2), epoch);
    expect(x.execute).toHaveBeenCalledTimes(1);
    expect(x.disk().journal.find(row => row.actionId === pending.data)).toMatchObject({ state: 'accepted', actionId: pending.data });
    expect(x.call.mock.calls).toHaveLength(3);
  });
  it.each(['person', 'chat', 'message', 'inline', 'bot', 'forum'])('rejects wrong %s without consuming the legitimate confirmation', async kind => {
    const x = fixture(), pending = await x.create(), update = x.update(pending.data);
    const cb = update.callback_query!;
    if (kind === 'person') cb.from.id = 789;
    if (kind === 'chat') cb.message!.chat.id = 789;
    if (kind === 'message') cb.message!.message_id = 78;
    if (kind === 'inline') delete cb.message;
    if (kind === 'bot') cb.from.is_bot = true;
    if (kind === 'forum') cb.message!.chat.is_forum = true;
    await x.actions.process(update, x.state.snapshot().epoch);
    expect(x.execute).not.toHaveBeenCalled();
    await x.actions.process(x.update(pending.data, 2), x.state.snapshot().epoch);
    expect(x.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['expiry', 'revoke', 'restart'])('invalidates %s and always acknowledges', async kind => {
    const x = fixture(), pending = await x.create();
    if (kind === 'expiry') x.expire();
    if (kind === 'revoke') x.revoke();
    if (kind === 'restart') x.actions.clear();
    await x.actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(x.execute).not.toHaveBeenCalled();
    expect(x.call).toHaveBeenCalledWith('answerCallbackQuery', expect.any(Object), expect.any(AbortSignal));
  });
  it('requires a valid send receipt and rejects a callback before delivery', async () => {
    const x = fixture(), pending = x.actions.create(x.preview())!;
    await x.actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(x.execute).not.toHaveBeenCalled();
    await pending.sent({ message_id: 77, chat: { id: 999 } });
    expect(pending.valid()).toBe(false);
  });
  it('bounds memory per user and expires without extending the original deadline', async () => {
    const x = fixture();
    for (let i = 0; i < 5; i++) expect(x.actions.create(x.preview())).toBeDefined();
    expect(x.actions.create(x.preview())).toBeUndefined(); x.expire();
    expect(x.actions.create(x.preview())).toBeDefined();
    for (let i = 1; i < 100; i++) expect(x.actions.create({ ...x.preview(), userId: String(i) })).toBeDefined();
    expect(x.actions.create({ ...x.preview(), userId: 'overflow' })).toBeUndefined();
  });
  it('consumes on write failure without performing any effect', async () => {
    const x = fixture(), pending = await x.create(); x.fail();
    await expect(x.actions.process(x.update(pending.data), x.state.snapshot().epoch)).rejects.toThrow('write failed');
    expect(x.execute).not.toHaveBeenCalled(); expect(pending.valid()).toBe(false);
    expect(x.call).toHaveBeenCalledWith('answerCallbackQuery', expect.any(Object), expect.any(AbortSignal));
  });
  it('records ambiguous effects without storing error text or retrying', async () => {
    const x = fixture(), pending = await x.create(); x.execute.mockRejectedValueOnce(new Error('secret'));
    await x.actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(x.disk().journal[0]?.state).toBe('uncertain'); expect(JSON.stringify(x.disk())).not.toContain('secret');
    await x.actions.process(x.update(pending.data, 2), x.state.snapshot().epoch);
    expect(x.execute).toHaveBeenCalledTimes(1);
  });
  it('rechecks after durable claim and again at the effect boundary', async () => {
    const x = fixture(), pending = await x.create();
    x.execute.mockImplementationOnce(async check => { x.revoke(); return !check(); });
    await x.actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason: 'action_refused' });
  });
});
it('recovers a failed result write as uncertain and rejects the old button after restart', async () => {
  const x = fixture(), pending = await x.create(), epoch = x.state.snapshot().epoch;
  x.execute.mockImplementationOnce(async () => { x.fail(); return true; });
  await expect(x.actions.process(x.update(pending.data), epoch)).rejects.toThrow('write failed');
  expect(x.disk().journal[0]?.state).toBe('claimed'); expect(x.execute).toHaveBeenCalledTimes(1);
  const restored = new InboundStateStore(x.disk(), { assertOwner() {}, async write() {} });
  await restored.recover();
  const restarted = new TelegramActions({ botId: '123', state: restored, call: x.call, reply: x.reply });
  await restarted.process(x.update(pending.data, 2), epoch);
  expect(restored.snapshot().journal.find(row => row.actionId === pending.data)?.state).toBe('uncertain');
  expect(x.execute).toHaveBeenCalledTimes(1);
});
it('does not let an unavailable callback acknowledgment block the task effect', async () => {
  vi.useFakeTimers();
  try {
    const x = fixture(), pending = await x.create();
    x.call.mockImplementation(() => new Promise(() => {}));
    const processing = x.actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(pending.valid()).toBe(false);
    await vi.advanceTimersByTimeAsync(0); expect(x.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); await processing;
    expect(x.disk().journal[0]?.state).toBe('accepted');
  } finally { vi.useRealTimers(); }
});

it('acknowledges during sendMessage cooldown but honors callback-specific 429 across action runtimes', async () => {
  const x = fixture(); let now = 1000; const budget = new TelegramSendBudget(() => now);
  budget.cooldown(60_000);
  const call = vi.fn().mockRejectedValueOnce(new TelegramApiError('http', 429, 3)).mockResolvedValue({});
  const make = () => new TelegramActions({ botId: '123', state: x.state, call, budget, reply() {}, now: () => now });
  await make().process(x.update('unknown', 1), x.state.snapshot().epoch);
  expect(call).toHaveBeenCalledTimes(1);
  await make().process(x.update('unknown', 2), x.state.snapshot().epoch);
  expect(call).toHaveBeenCalledTimes(1);
  now += 3000; await make().process(x.update('unknown', 3), x.state.snapshot().epoch);
  expect(call).toHaveBeenCalledTimes(2);
});
it('does not answer or consume anything for a replayed callback update', async () => {
  const x = fixture(), pending = await x.create(), epoch = x.state.snapshot().epoch;
  await x.state.finish(epoch, 1);
  await x.actions.process(x.update(pending.data), epoch);
  expect(x.call).not.toHaveBeenCalled(); expect(x.execute).not.toHaveBeenCalled(); expect(pending.valid()).toBe(true);
});

describe('option buttons sharing one action', () => {
  it('gives each choice its own id, consumes every sibling on the first tap and counts as one pending action', async () => {
    const x = fixture(), perform = vi.fn(async () => {});
    const pending = x.actions.create({ ...x.preview(), kind: 'answer', choices: 3, ttlMs: 15 * 60_000, perform })!;
    expect(new Set(pending.choices).size).toBe(3);
    for (const id of pending.choices) expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Four more single actions still fit the per-person cap of five.
    for (let i = 0; i < 4; i++) expect(x.actions.create(x.preview())).toBeDefined();
    expect(x.actions.create(x.preview())).toBeUndefined();
    await pending.sent({ message_id: 77, chat: { id: 456 } });
    await x.actions.process(x.update(pending.choices[2]!), x.state.snapshot().epoch);
    await x.actions.process(x.update(pending.choices[0]!, 2), x.state.snapshot().epoch);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ updateId: 1, entry: expect.objectContaining({ kind: 'answer', actionId: pending.choices[0] }) }), expect.any(Function), 2);
    expect(x.call).toHaveBeenCalledWith('answerCallbackQuery', expect.objectContaining({ text: 'Sending your answer…' }), expect.any(AbortSignal));
    expect(x.execute).not.toHaveBeenCalled();
  });
  it('caps the lifetime at fifteen minutes and releases an unsent action', async () => {
    const x = fixture();
    const long = x.actions.create({ ...x.preview(), ttlMs: 60 * 60_000 })!;
    const unsent = x.actions.create(x.preview())!;
    unsent.release(); expect(unsent.valid()).toBe(false);
    await long.sent({ message_id: 77, chat: { id: 456 } }); long.release(); expect(long.valid()).toBe(true);
    x.expire(); x.expire(); x.expire(); x.expire(); x.expire(); x.expire(); x.expire();
    expect(long.valid()).toBe(true); x.expire(); expect(long.valid()).toBe(false);
  });
});

describe('Telegram confirmation copy and group membership', () => {
  const answered = (call: ReturnType<typeof vi.fn>) => (call.mock.calls as unknown as [string, { text?: string }][])
    .filter(([method]) => method === 'answerCallbackQuery').map(([, body]) => body.text);
  it('tells someone else tapping the button that it belongs to another person, not that it expired', async () => {
    const x = fixture(), pending = await x.create(), update = x.update(pending.data);
    update.callback_query!.from.id = 789;
    await x.actions.process(update, x.state.snapshot().epoch);
    expect(answered(x.call)).toEqual(['This button belongs to another person.']);
    x.expire(); await x.actions.process(x.update(pending.data, 2), x.state.snapshot().epoch);
    expect(answered(x.call).at(-1)).toContain('no longer available');
  });
  it.each([['continue', 'Continuing task task.'], ['cancel', 'Cancelled task task.']] as const)('says what a confirmed %s did', async (kind, text) => {
    const x = fixture(), pending = x.actions.create({ ...x.preview(), kind })!;
    await pending.sent({ message_id: 77, chat: { id: 456 } });
    await x.actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(x.reply).toHaveBeenCalledWith('456', text, expect.any(Function));
  });
  it.each([[false, 'not_member', 'no longer a member'], [undefined, 'membership_unknown', 'Could not confirm']] as const)(
    'refuses a group tap when membership is %s', async (member, reason, text) => {
      const x = fixture(), check = vi.fn(async () => member);
      const actions = new TelegramActions({ botId: '123', state: x.state, call: x.call, reply: x.reply, now: () => 1000, member: check });
      const pending = actions.create({ ...x.preview(), chatId: '-100' })!;
      await pending.sent({ message_id: 77, chat: { id: -100 } });
      const update = x.update(pending.data); update.callback_query!.message!.chat = { id: -100, type: 'supergroup' };
      await actions.process(update, x.state.snapshot().epoch);
      expect(check).toHaveBeenCalledWith('-100', '456');
      expect(x.execute).not.toHaveBeenCalled();
      expect(answered(x.call)[0]).toContain(text);
      expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'continue', state: 'rejected', reason });
    });
  it('never asks Telegram about membership for a private chat', async () => {
    const x = fixture(), check = vi.fn(async () => false);
    const actions = new TelegramActions({ botId: '123', state: x.state, call: x.call, reply: x.reply, now: () => 1000, member: check });
    const pending = actions.create(x.preview())!; await pending.sent({ message_id: 77, chat: { id: 456 } });
    await actions.process(x.update(pending.data), x.state.snapshot().epoch);
    expect(check).not.toHaveBeenCalled(); expect(x.execute).toHaveBeenCalledTimes(1);
  });
});

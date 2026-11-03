import { expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { TelegramSendBudget, clearSharedTelegramCooldowns } from './send-budget.ts';
afterEach(() => clearSharedTelegramCooldowns());

it('rotates ready chats instead of draining the oldest chat backlog', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  const add = (id: string, chat: string) => budget.offer({ id, chat, readyAt: 0, expiresAt: 60_000, valid: () => true });
  add('a1', 'a'); add('a2', 'a'); add('b1', 'b'); add('c1', 'c');
  expect(budget.take('a2')).toBe(false); expect(budget.take('a1')).toBe(true);
  now = 2000; // A slow transport must not let A regain priority ahead of B and C.
  expect(budget.take('a2')).toBe(false); expect(budget.take('b1')).toBe(true);
  now += 100; expect(budget.take('c1')).toBe(true);
  now += 100; expect(budget.take('a2')).toBe(true);
});
it('shares per-chat and bot spacing across reply and webhook tickets', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  for (const [id, chat] of [['reply', 'a'], ['webhook', 'a'], ['other', 'b']]) budget.offer({ id: id!, chat: chat!, readyAt: 0, expiresAt: 10_000, valid: () => true });
  expect(budget.take('reply')).toBe(true); expect(budget.take('other')).toBe(false);
  now = 100; expect(budget.take('other')).toBe(true);
  now = 999; expect(budget.take('webhook')).toBe(false);
  now = 1000; expect(budget.take('webhook')).toBe(true);
});
it('uses one global ready winner across mixed consumers', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  budget.offer({ id: 'older-webhook', chat: 'webhook-chat', readyAt: 0, expiresAt: 10_000, valid: () => true });
  budget.offer({ id: 'reply', chat: 'reply-chat', readyAt: 0, expiresAt: 10_000, valid: () => true });
  expect(budget.winner()).toBe('older-webhook');
  expect(budget.take('reply')).toBe(false);
  expect(budget.take('older-webhook')).toBe(true);
  now = 100; expect(budget.take('reply')).toBe(true);
});
it('shares a long cooldown, never shortens it, and leaves other bots unaffected', () => {
  let now = 0; const a = new TelegramSendBudget(() => now), b = new TelegramSendBudget(() => now);
  for (const budget of [a, b]) budget.offer({ id: 'head', chat: 'chat', readyAt: 0, expiresAt: 100_000, valid: () => true });
  a.cooldown(60_000); a.cooldown(1000); expect(a.take('head')).toBe(false); expect(b.take('head')).toBe(true);
  now = 60_000; expect(a.take('head')).toBe(true);
});
it('prunes expired, revoked and cancelled work without consuming capacity', () => {
  let now = 0, valid = true; const budget = new TelegramSendBudget(() => now);
  budget.offer({ id: 'revoked', chat: 'a', readyAt: 0, expiresAt: 1000, valid: () => valid });
  budget.offer({ id: 'cancelled', chat: 'b', readyAt: 0, expiresAt: 1000, valid: () => true });
  budget.offer({ id: 'expired', chat: 'c', readyAt: 0, expiresAt: 100, valid: () => true });
  budget.offer({ id: 'live', chat: 'd', readyAt: 0, expiresAt: 1000, valid: () => true });
  valid = false; budget.cancel('cancelled'); now = 100;
  expect(budget.take('live')).toBe(true);
});
it('is bounded and updating a ticket preserves its queue position', () => {
  const budget = new TelegramSendBudget(() => 0);
  const row = (id: string) => ({ id, chat: 'chat', readyAt: 0, expiresAt: 1000, valid: () => true });
  for (let i = 0; i < 200; i++) expect(budget.offer(row(String(i)))).toBe(true);
  expect(budget.offer(row('overflow'))).toBe(false);
  expect(budget.offer(row('0'))).toBe(true); expect(budget.take('0')).toBe(true);
});
it('reserves a slot during durable claim, starting spacing only when transport starts', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  for (const id of ['webhook', 'reply']) budget.offer({ id, chat: id, readyAt: 0, expiresAt: 10_000, valid: () => true });
  const reservation = budget.reserve('webhook')!;
  expect(reservation).toBeDefined(); now = 500;
  expect(budget.take('reply')).toBe(false);
  reservation.sent(); expect(budget.take('reply')).toBe(false);
  reservation.release(); now = 600; expect(budget.take('reply')).toBe(true);
});
it('releases an abandoned claim without spending a slot', () => {
  const budget = new TelegramSendBudget(() => 0);
  budget.offer({ id: 'webhook', chat: 'a', readyAt: 0, expiresAt: 10_000, valid: () => true });
  const reservation = budget.reserve('webhook')!;
  reservation.release(); expect(budget.take('webhook')).toBe(true);
});
it('keeps callback acknowledgments independent of sendMessage and respects their own cooldown', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  budget.cooldown(60_000);
  expect(budget.methodReady('answerCallbackQuery')).toBe(true);
  budget.cooldownMethod('answerCallbackQuery', 3000);
  expect(budget.methodReady('answerCallbackQuery')).toBe(false);
  expect(budget.methodReady('editMessageReplyMarkup')).toBe(true);
  now = 3000; expect(budget.methodReady('answerCallbackQuery')).toBe(true);
});
it('wakes at the earliest ticket or chat cooldown instead of polling every 100ms', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  budget.offer({ id: 'future', chat: 'a', readyAt: 5000, expiresAt: 10_000, valid: () => true });
  expect(budget.nextCheck()).toBe(5000);
  now = 5000; expect(budget.take('future')).toBe(true);
  budget.offer({ id: 'chat', chat: 'a', readyAt: 0, expiresAt: 20_000, valid: () => true });
  budget.offer({ id: 'other', chat: 'b', readyAt: 0, expiresAt: 20_000, valid: () => true });
  expect(budget.nextCheck()).toBe(5100);
});
it('caps a 429 cooldown at one hour', () => {
  let now = 0; const budget = new TelegramSendBudget(() => now);
  budget.offer({ id: 'head', chat: 'a', readyAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, valid: () => true });
  budget.cooldown(30 * 86_400_000);
  now = 3_600_000; expect(budget.take('head')).toBe(true);
});
it('a backward wall-clock step never stretches spacing or cooldown beyond the interval that set it', () => {
  let now = Date.parse('2026-10-29T12:00:00Z'); const budget = new TelegramSendBudget(() => now);
  const add = (id: string) => budget.offer({ id, chat: 'a', readyAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, valid: () => true });
  add('first'); add('second'); expect(budget.take('first')).toBe(true);
  now -= 86_400_000; expect(budget.take('second')).toBe(false);
  now += 1000; expect(budget.take('second')).toBe(true);
  add('third'); budget.cooldown(now + 60_000);
  now -= 86_400_000; expect(budget.nextCheck()).toBe(now + 60_000);
  now += 60_000; expect(budget.take('third')).toBe(true);
});
it('does not ask for a re-check while a send is reserved and notifies on release', () => {
  const budget = new TelegramSendBudget(() => 0);
  budget.offer({ id: 'webhook', chat: 'a', readyAt: 0, expiresAt: 10_000, valid: () => true });
  const reservation = budget.reserve('webhook')!, woke: string[] = [];
  expect(budget.nextCheck()).toBe(Number.POSITIVE_INFINITY);
  budget.afterRelease(() => woke.push('released'));
  expect(woke).toEqual([]); reservation.release();
  expect(woke).toEqual(['released']); expect(budget.nextCheck()).toBe(100);
});
it('shares a bot cooldown with a recreated budget bound to the same credential', () => {
  let now = 0; const first = new TelegramSendBudget(() => now);
  first.share('bot'); first.cooldown(60_000);
  const second = new TelegramSendBudget(() => now), other = new TelegramSendBudget(() => now);
  second.share('bot'); other.share('other');
  for (const budget of [second, other]) budget.offer({ id: 'head', chat: 'a', readyAt: 0, expiresAt: 120_000, valid: () => true });
  expect(second.take('head')).toBe(false); expect(other.take('head')).toBe(true);
  now = 60_000; expect(second.take('head')).toBe(true);
});
it('skips a parked ticket so a consumer that cannot send now does not stall other chats', () => {
  let parked = true; const budget = new TelegramSendBudget(() => 0);
  budget.offer({ id: 'webhook', chat: 'a', readyAt: 0, expiresAt: 10_000, valid: () => true, parked: () => parked });
  budget.offer({ id: 'reply', chat: 'b', readyAt: 0, expiresAt: 10_000, valid: () => true });
  expect(budget.winner()).toBe('reply');
  parked = false; expect(budget.winner()).toBe('webhook');
  budget.offer({ id: 'throws', chat: 'c', readyAt: 0, expiresAt: 10_000, valid: () => true, parked: () => { throw new Error('x'); } }, true);
  budget.cancel('webhook'); budget.cancel('reply');
  expect(budget.winner()).toBeUndefined();
});

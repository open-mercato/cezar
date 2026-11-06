import { randomUUID } from 'node:crypto';
import { TelegramSendBudget } from './send-budget.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
export { renderTelegramSourceOutcome, renderTelegramTaskReply } from '../webhooks/telegram.ts';
export type { TelegramTaskReply } from '../webhooks/telegram.ts';
export interface ConfirmationButton { text: string; callback_data: string }
/** One Confirm button, or rows of option buttons (Telegram allows at most 100). */
export type ReplyKeyboard = ConfirmationButton | readonly (readonly ConfirmationButton[])[];
const keyboard = (value: ReplyKeyboard): readonly (readonly ConfirmationButton[])[] => 'callback_data' in value ? [[value]] : value;
export type ReplySettlement = 'sent' | 'failed' | 'invalid' | 'expired' | 'dropped' | 'superseded' | 'stopped';
interface Reply {
  id: string; button?: ReplyKeyboard;
  chatId: string; text: string; valid(): boolean; sent?(result: unknown): Promise<void>;
  failed?(): Promise<void>; settled?(outcome: ReplySettlement): void;
  expiresAt: number; nextAt: number; attempts: number;
}
export interface TelegramReplyDelivery {
  key?: string; expiresInMs?: number;
  valid(): boolean; sent?(result: unknown): Promise<void>; failed?(): Promise<void>;
  /** Once, when the reply leaves the dispatcher for good: after sent/failed resolve, or when dropped or superseded. */
  settled?(outcome: ReplySettlement): void;
}
const settle = (reply: Reply, outcome: ReplySettlement) => { const settled = reply.settled; reply.settled = undefined; settled?.(outcome); };
/** Bounded ephemeral replies, independent of update processing and durable task effects. */
export class TelegramReplies {
  private queue: Reply[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller = new AbortController();
  dropped = 0;
  constructor(private readonly call: TelegramCall, private readonly now: () => number = Date.now, private readonly budget = new TelegramSendBudget(now)) {}
  enqueue(chatId: string, text: string, valid: () => boolean, sent?: Reply['sent'], button?: ReplyKeyboard): boolean {
    return this.deliver(chatId, text, { valid, ...(sent ? { sent } : {}) }, button);
  }
  deliver(chatId: string, text: string, delivery: TelegramReplyDelivery, button?: ReplyKeyboard): boolean {
    this.prune();
    const id = delivery.key ? `reply:${delivery.key}` : `reply:${randomUUID()}`;
    const existing = this.queue.find(reply => reply.id === id);
    if (existing) {
      if (this.controller.signal.aborted || text.length > 4096 || existing.chatId !== chatId) { this.dropped++; return false; }
      if (existing.settled !== delivery.settled) settle(existing, 'superseded');
      existing.text = text; existing.valid = delivery.valid; existing.sent = delivery.sent; existing.failed = delivery.failed; existing.settled = delivery.settled;
      if (button) existing.button = button; else delete existing.button;
      existing.expiresAt = this.now() + (delivery.expiresInMs ?? 120_000); existing.nextAt = Math.min(existing.nextAt, this.now());
      this.offer(existing); this.schedule(); return true;
    }
    if (this.controller.signal.aborted || text.length > 4096 || this.queue.length >= 100 || this.queue.filter(reply => reply.chatId === chatId).length >= 10) {
      this.dropped++; return false;
    }
    const reply: Reply = { id, chatId, text, valid: delivery.valid, ...(button ? { button } : {}), ...(delivery.sent ? { sent: delivery.sent } : {}), ...(delivery.failed ? { failed: delivery.failed } : {}), ...(delivery.settled ? { settled: delivery.settled } : {}), expiresAt: this.now() + (delivery.expiresInMs ?? 120_000), nextAt: this.now(), attempts: 0 };
    if (!this.offer(reply)) { this.dropped++; return false; }
    this.queue.push(reply);
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.schedule(); return true;
  }
  private offer(reply: Reply, firstInChat = false): boolean {
    return this.budget.offer({ id: reply.id, chat: reply.chatId, readyAt: reply.nextAt, expiresAt: reply.expiresAt, valid: reply.valid }, firstInChat);
  }
  prune(): void {
    const now = this.now();
    this.queue = this.queue.filter(reply => {
      if (reply.expiresAt > now && reply.valid()) return true;
      this.budget.cancel(reply.id); settle(reply, reply.expiresAt <= now ? 'expired' : 'invalid'); return false;
    });
  }
  /** Remove an unsent keyed reply when a newer observation supersedes it. */
  cancel(key: string): boolean {
    const id = key.startsWith('reply:') ? key : `reply:${key}`;
    const index = this.queue.findIndex(reply => reply.id === id);
    if (index < 0) return false;
    settle(this.queue.splice(index, 1)[0]!, 'superseded');
    this.budget.cancel(id);
    this.schedule();
    return true;
  }
  private schedule(): void {
    if (this.timer || this.active || this.controller.signal.aborted) return;
    this.prune(); if (!this.queue.length) return;
    const winner = this.budget.winner();
    const at = this.queue.some(reply => reply.id === winner) ? this.now() : this.budget.nextCheck();
    // Keep a short cap so a manually advanced/test clock or wall-clock
    // correction cannot strand a reply behind a stale deadline.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.send().finally(() => { this.active = undefined; this.schedule(); });
    }, Math.max(0, Math.min(100, at - this.now())));
    this.timer.unref();
  }
  private async send(): Promise<void> {
    this.prune();
    const winner = this.budget.winner(), index = this.queue.findIndex(reply => reply.id === winner);
    if (index < 0) return;
    const reservation = this.budget.reserve(this.queue[index]!.id); if (!reservation) return;
    const reply = this.queue.splice(index, 1)[0]!;
    if (!reply.valid() || this.controller.signal.aborted) {
      // The ticket was removed from the local queue before this final check.
      // Cancel it too, or a shared budget retains an orphan until its TTL.
      this.budget.cancel(reply.id); reservation.release(); settle(reply, this.controller.signal.aborted ? 'stopped' : 'invalid'); return;
    }
    reply.attempts++; reservation.sent();
    let requeued = false;
    let outcome: ReplySettlement = 'sent';
    try {
      const result = await this.call('sendMessage', { chat_id: reply.chatId, text: reply.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(reply.button ? { reply_markup: { inline_keyboard: keyboard(reply.button) } } : {}) }, this.controller.signal, { valid: reply.valid });
      // A failed correlation write must never retry the delivered response.
      if (reply.valid()) await reply.sent?.(result).catch(() => undefined);
    } catch (error) {
      outcome = this.controller.signal.aborted ? 'stopped' : !reply.valid() ? 'invalid' : 'failed';
      if (error instanceof TelegramApiError && error.status === 429) this.budget.cooldown(this.now() + (error.retryAfter ?? 5) * 1000);
      const retryable = error instanceof TelegramApiError && (error.code === 'network' || error.status === 429 || (error.status ?? 0) >= 500);
      if (!retryable || reply.attempts >= 3 || this.controller.signal.aborted || !reply.valid()) {
        if (!this.controller.signal.aborted && reply.valid()) await reply.failed?.().catch(() => undefined);
        return;
      }
      reply.nextAt = this.now() + (error.status === 429 ? (error.retryAfter ?? 5) * 1000 : 1000 * reply.attempts);
      if (reply.nextAt < reply.expiresAt && this.queue.length < 100 && this.queue.filter(item => item.chatId === reply.chatId).length < 10 && this.offer(reply, true)) { this.queue.push(reply); requeued = true; }
      else { this.dropped++; outcome = 'dropped'; }
    } finally { reservation.release(); if (!requeued) settle(reply, outcome); }
  }
  async stop(): Promise<void> {
    this.controller.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const queued = this.queue; this.queue = [];
    for (const reply of queued) { this.budget.cancel(reply.id); settle(reply, 'stopped'); }
    await this.active;
  }
}

/** Bounded minute buckets; saturation refuses new keys rather than evicting active limits. */
export class CommandLimiter {
  private users = new Map<string, { until: number; count: number; seen: number }>();
  private bot = { until: 0, count: 0 };
  constructor(private readonly now: () => number = Date.now) {}
  accept(userId: string): boolean {
    const now = this.now();
    for (const [key, value] of this.users) if (value.seen < now - 600_000) this.users.delete(key);
    if (this.bot.until <= now) this.bot = { until: now + 60_000, count: 0 };
    let user = this.users.get(userId);
    if (!user && this.users.size >= 1000) return false;
    if (!user || user.until <= now) { user = { until: now + 60_000, count: 0, seen: now }; this.users.set(userId, user); }
    user.seen = now;
    if (this.bot.count >= 100 || user.count >= 20) return false;
    this.bot.count++; user.count++; return true;
  }
}

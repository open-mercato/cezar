import { ChatReplies, type ChatReplyDelivery, type ReplyKeyboard as CoreKeyboard } from '../dispatcher.ts';
import { ChatSendBudget } from '../send-budget.ts';
import type { TelegramCall } from './telegram-wire.testkit.ts';
import { telegramSession } from './telegram-wire.testkit.ts';
export interface ConfirmationButton { text: string; callback_data: string }
export type ReplyKeyboard = ConfirmationButton | readonly (readonly ConfirmationButton[])[];
const normalized = (button?: ReplyKeyboard): CoreKeyboard | undefined => button && ('callback_data' in button
  ? { text: button.text, data: button.callback_data }
  : button.map(row => row.map(button => ({ text: button.text, data: button.callback_data }))));
const wire = (result: unknown): unknown => {
  const receipt = result as { messageId: string; chatId: string };
  return { message_id: Number(receipt.messageId), chat: { id: Number(receipt.chatId) } };
};
/** Telegram wire shapes over ChatReplies for tests; scheduling and retry policy belong to ChatReplies. */
export class TelegramReplies {
  private readonly core: ChatReplies;
  constructor(call: TelegramCall, now?: () => number, budget?: ChatSendBudget) { this.core = new ChatReplies(telegramSession(call), now, budget); }
  get dropped() { return this.core.dropped; }
  enqueue(chatId: string, text: string, valid: () => boolean, sent?: (result: unknown) => Promise<void>, button?: ReplyKeyboard) {
    return this.deliver(chatId, text, { valid, ...(sent ? { sent } : {}) }, button);
  }
  deliver(chatId: string, text: string, delivery: ChatReplyDelivery, button?: ReplyKeyboard) {
    return this.core.deliver(chatId, text, { ...delivery, ...(delivery.sent ? { sent: (result: unknown) => delivery.sent!(wire(result)) } : {}) }, normalized(button));
  }
  prune() { this.core.prune(); }
  cancel(key: string) { return this.core.cancel(key); }
  stop() { return this.core.stop(); }
}
export type { ReplySettlement, ChatReplyDelivery as TelegramReplyDelivery } from '../dispatcher.ts';
export { renderTelegramSourceOutcome, renderTelegramTaskReply } from '../providers/telegram/render.ts';

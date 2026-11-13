/** Wire-fixture adapters for the existing Telegram regression suites. No production consumer. */
import { ChatActions } from '../actions.ts';
import { ChatConversation, chatHelp, chatAccessGrantedText, type ConversationDependencies as CoreDependencies } from '../conversation.ts';
import { classifyChatMessage, type RouterContext } from '../message-router.ts';
import { telegramPresentation } from '../providers/telegram/presentation.ts';
import { telegramSession } from './telegram-wire.testkit.ts';
import { normalizeUpdate } from './telegram-wire.testkit.ts';
import type { TelegramCall } from './telegram-wire.testkit.ts';
import type { TelegramUpdate } from './telegram-wire.testkit.ts';
import type { ReplyKeyboard } from './telegram-replies.testkit.ts';
const receipt = (raw: unknown): unknown => {
 const r = raw as { message_id?: number; chat?: { id: number } };
 return r?.message_id && r.chat ? { messageId: String(r.message_id), chatId: String(r.chat.id) } : raw;
};
export class TelegramActions extends ChatActions {
 constructor(deps: Omit<ConstructorParameters<typeof ChatActions>[0], 'session' | 'presentation'> & { call: TelegramCall }) { super({ ...deps, session: telegramSession(deps.call), presentation: telegramPresentation }); }
 override create(preview: Parameters<ChatActions['create']>[0]) {
  const result = super.create(preview); return result && { ...result, sent: (raw: unknown) => result.sent(receipt(raw)) };
 }
 override process(update: TelegramUpdate | Parameters<ChatActions['process']>[0], epoch: string) { return super.process('update_id' in update ? normalizeUpdate(update, '') : update, epoch); }
}
export type ConversationDependencies = Omit<CoreDependencies, 'presentation' | 'reply'> & {
 reply(chatId: string, text: string, valid: () => boolean, sent?: (raw: unknown) => Promise<void>, button?: ReplyKeyboard): void;
};
export class TelegramConversation extends ChatConversation {
 private readonly botUsername: string;
 constructor(deps: ConversationDependencies) {
  super({ ...deps, presentation: telegramPresentation, reply(chatId, text, valid, sent, button) {
   const wire = button && ('data' in button ? { text: button.text, callback_data: button.data } : button.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))));
   deps.reply(chatId, text, valid, sent ? raw => sent(receipt(raw)) : undefined, wire);
  } }); this.botUsername = deps.username;
 }
 override process(update: TelegramUpdate | Parameters<ChatConversation['process']>[0], epoch: string) { return super.process('update_id' in update ? normalizeUpdate(update, this.botUsername) : update, epoch); }
}
export const classifyTelegramMessage = (update: TelegramUpdate, context: RouterContext) => classifyChatMessage(normalizeUpdate(update, context.botUsername), context);
export const telegramHelp = (username?: string) => chatHelp(telegramPresentation, username);
export const telegramAccessGrantedText = (chatId: string, username: string) => chatAccessGrantedText(telegramPresentation, chatId, username);
export { NoticeThrottle, CHAT_ANSWER_NOTES, chatAnswerMode, chatOptionLabels, chatSafe } from '../conversation.ts';
export type { ActionPreview, PendingAction } from '../actions.ts';
export type { RouterContext, ChatMessageRoute as TelegramMessageRoute } from '../message-router.ts';
import { Pairings as CorePairings } from '../pairing.ts';
import { normalizeMessage } from './telegram-wire.testkit.ts';
import type { TelegramMessage } from './telegram-wire.testkit.ts';
export class Pairings extends CorePairings {
 constructor(now?: () => number) { super(telegramPresentation, now); }
 override accept(botId: string, username: string, message: TelegramMessage | Parameters<CorePairings['accept']>[2]) {
  const input = 'message_id' in message ? normalizeMessage(message, username) : message;
  return input ? super.accept(botId, username, input) : 'ignored';
 }
 override comparisonCode(botId: string, username: string, message: TelegramMessage | Parameters<CorePairings['comparisonCode']>[2]) {
  const input = 'message_id' in message ? normalizeMessage(message, username) : message;
  return input ? super.comparisonCode(botId, username, input) : undefined;
 }
}

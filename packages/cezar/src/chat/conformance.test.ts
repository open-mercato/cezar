import type { ChatMessage } from './provider.ts';
import { slackPresentation } from './providers/slack/presentation.ts';
import { discordPresentation } from './providers/discord/presentation.ts';
import { providerConformance } from './test-support/conformance.testkit.ts';
import { telegramPresentation } from './providers/telegram/presentation.ts';
import { telegramSession } from './test-support/telegram-wire.testkit.ts';
import { TelegramApiError } from './test-support/telegram-wire.testkit.ts';
import { ChatTransportError } from './provider.ts';
providerConformance('Telegram adapter', {
 id: 'telegram', botId: '123', userId: '456', privateChat: '456', groupChat: '-100', presentation: telegramPresentation, messageId: String,
 session: send => telegramSession(async (method, raw) => {
  const body = raw as Record<string, any>;
  if (method === 'getMe') return { id: 123, username: 'bot' };
  if (method === 'getChatMember') return { user: { id: Number(body.user_id) }, status: 'member' };
  if (method === 'sendMessage') {
   try {
    const receipt = await send(String(body.chat_id), { text: body.text, ...(body.reply_markup ? { buttons: body.reply_markup.inline_keyboard.map((row: any[]) => row.map(button => ({ text: button.text, data: button.callback_data }))) } : {}) });
    return { message_id: Number(receipt.messageId), chat: { id: Number(receipt.chatId) } };
   } catch (error) { if (error instanceof ChatTransportError && error.failure.kind === 'rate_limited') throw new TelegramApiError('http', 429, 1); throw error; }
  }
  return true;
 }),
});
providerConformance('simulated socket provider with nonnumeric identities', {
 id: 'slack', botId: 'TTEAM:UBOT', userId: 'UACTOR', privateChat: 'private:TTEAM:UBOT:DCHAT', groupChat: 'group:TTEAM:UBOT:CCHAT', messageId: index => `${index}.000001`,
 presentation: { label: 'Simulated', maxText: 2000, buttonTextLimit: 40, formatText: text => text.slice(0, 2000), command: name => `/${name}`,
  isGroup: id => id === 'group:TTEAM:UBOT:CCHAT', discoveryLink: (_username, code) => `https://simulated.invalid/discovery/${code}`,
  taskReply: task => `Task ${task.status === 'review' ? 'ready' : task.status}: ${task.title}`, sourceOutcome: source => source.state },
 session: send => ({ identify: async () => ({ id: 'TTEAM:UBOT', username: 'bot' }), send, clearButtons: async () => {}, acknowledge: async () => {}, isMember: async () => true }),
});
// Core behaviour under each native presentation; the wire belongs to the shipped adapters.
const plainSession = (id: string, send: Parameters<Parameters<typeof providerConformance>[1]['session']>[0]) => ({
 identify: async () => ({ id, username: id }), send: (chatId: string, message: ChatMessage) => send(chatId, message),
 clearButtons: async () => {}, acknowledge: async () => {}, isMember: async () => true,
});
providerConformance('Slack presentation', { id: 'slack', botId: 'T1:U1', userId: 'U2', privateChat: 'private:T1:U1:D1', groupChat: 'group:T1:U1:C1', presentation: slackPresentation,
 messageId: index => `1700000000.${String(index).padStart(6, '0')}`, session: send => plainSession('T1:U1', send) });
providerConformance('Discord presentation', { id: 'discord', botId: '1', userId: '2', privateChat: 'discord:dm:10', groupChat: 'discord:guild:20:30', messageId: index => String(index),
 presentation: discordPresentation, session: send => plainSession('1', send) });

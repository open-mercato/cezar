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
 id: 'acme/chat', botId: 'TTEAM:UBOT', userId: 'UACTOR', privateChat: 'private:TTEAM:UBOT:DCHAT', groupChat: 'group:TTEAM:UBOT:CCHAT', messageId: index => `${index}.000001`,
 presentation: { label: 'Simulated', maxText: 2000, buttonTextLimit: 40, formatText: text => text.slice(0, 2000), command: name => `/${name}`,
  isGroup: id => id === 'group:TTEAM:UBOT:CCHAT', discoveryLink: (_username, code) => `https://simulated.invalid/discovery/${code}`,
  taskReply: task => `Task ${task.status === 'review' ? 'ready' : task.status}: ${task.title}`, sourceOutcome: source => source.state },
 session: send => ({ identify: async () => ({ id: 'TTEAM:UBOT', username: 'bot' }), send, clearButtons: async () => {}, acknowledge: async () => {}, isMember: async () => true }),
});

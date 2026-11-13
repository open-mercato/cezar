import { chatIdentifierSchemas } from '@open-mercato/cezar-contract';
import { telegramToken } from '../../../webhooks/telegram-secrets.ts';
import type { ChatProvider, ChatServiceDescriptor } from '../../provider.ts';
import { telegramPresentation } from './presentation.ts';
export const telegramProvider: ChatProvider = {
  id: 'telegram', label: 'Telegram',
  credentials: [{ name: 'token', label: 'Bot token', pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/ }],
  limits: { maxText: 4096, buttonsPerMessage: 100, perChatPerSecond: 1, perBotPerSecond: 10 },
  ids: chatIdentifierSchemas.telegram,
  renderText: telegramPresentation.formatText, command: telegramPresentation.command, discoveryLink: telegramPresentation.discoveryLink,
};
export const telegramServiceDescriptor: ChatServiceDescriptor = {
  ...telegramProvider, format: 'telegram.v1', presentation: telegramPresentation,
  destination: credential => `https://api.telegram.org/bot${credential}/sendMessage`,
  adapterCredential: token => JSON.stringify({ token }), textFormat: 'telegram-html',
  credentialBotId(destination) { try { return destination ? telegramToken(destination)?.split(':')[0] : undefined; } catch { return undefined; } },
};

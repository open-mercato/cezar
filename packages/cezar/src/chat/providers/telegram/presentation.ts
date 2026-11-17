import { formatTelegramText, renderTelegramSourceOutcome, renderTelegramTaskReply } from './render.ts';
import type { ChatPresentation } from '../../presentation.ts';
export const telegramPresentation: ChatPresentation = {
  label: 'Telegram', maxText: 4096, buttonTextLimit: 64,
  formatText: formatTelegramText,
  command: (name, username) => `/${name}${username ? `@${username}` : ''}`,
  isGroup: id => id.startsWith('-'),
  discoveryLink(username, code) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(username)) throw new Error('invalid_bot_username');
    return `https://t.me/${username}?start=${code}`;
  },
  taskReply: renderTelegramTaskReply, sourceOutcome: renderTelegramSourceOutcome,
};

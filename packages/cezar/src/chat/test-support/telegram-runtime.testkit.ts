import { ChatBotRuntime } from '../runtime.ts';
import { TelegramPoller } from './telegram-wire.testkit.ts';
import { telegramSession } from './telegram-wire.testkit.ts';
import { telegramPresentation } from '../providers/telegram/presentation.ts';
import { normalizeUpdate } from './telegram-wire.testkit.ts';
import { TELEGRAM_COMMANDS } from './telegram-wire.testkit.ts';
import type { TelegramCall } from './telegram-wire.testkit.ts';
export class TelegramBotRuntime extends ChatBotRuntime {
 constructor(deps: Omit<ConstructorParameters<typeof ChatBotRuntime>[0], 'session' | 'presentation' | 'connect'> & { call: TelegramCall }) {
  const session = telegramSession(deps.call); let username = '';
  super({ ...deps, presentation: telegramPresentation, session: { ...session, async identify(signal) {
   const me = await session.identify(signal); username = me.username;
   void deps.call('setMyCommands', { commands: TELEGRAM_COMMANDS }, signal).catch(() => undefined);
   return me;
  } }, connect: options => new TelegramPoller({ ...options, call: deps.call, store: deps.state, now: deps.now,
   allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
   process: (update, epoch) => options.process(normalizeUpdate(update, username), epoch),
  }) });
 }
}

import { Hono } from 'hono';
import { telegramInboundBotParamSchema, telegramOrphanReleaseQuerySchema, type TelegramDomainError } from '@open-mercato/cezar-contract';
import { paramZodValidator, queryZodValidator } from './validators.ts';
import { TelegramBindings } from '../telegram/bindings.ts';
import { TelegramInboundFailure } from '../telegram/service.ts';
import { BotOwnershipError } from '../telegram/ownership.ts';
/** Exact workspace paths only, before the project's /telegram/* catch-all. */
export function createTelegramBindingRoutes(bindings: TelegramBindings) {
  const domainError = (error: string, code: string): TelegramDomainError => ({ error, code });
  return new Hono()
    .onError((error, c) => {
      if (error instanceof TelegramInboundFailure) return c.json(domainError(error.code, error.code), error.status);
      if (error instanceof BotOwnershipError) return c.json(domainError('Bot has an active owner or a changed binding.', 'bot_conflict'), 409);
      return c.json(domainError('Bot bindings are temporarily unavailable.', 'unavailable'), 503);
    })
    .get('/telegram/bot-bindings', async c => { c.header('Cache-Control', 'no-store'); return c.json(await bindings.list()); })
    .delete('/telegram/bot-bindings/:botId', paramZodValidator(telegramInboundBotParamSchema), queryZodValidator(telegramOrphanReleaseQuerySchema), async c => {
      c.header('Cache-Control', 'no-store'); return c.json(await bindings.release(c.req.valid('param').botId, c.req.valid('query').expectedRevision));
    });
}

import { Hono, type MiddlewareHandler } from 'hono';
import {
  telegramInboundIdParamSchema, telegramInboundBotParamSchema, telegramInboundActivityQuerySchema,
  telegramInboundReceiverPatchSchema,
  telegramInboundRevisionQuerySchema, telegramInboundResetSchema, telegramInboundGrantPatchSchema,
  telegramSetupBeginSchema, telegramSetupActivateSchema,
  type TelegramInboundStateResponse, type TelegramDomainError,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { TelegramInboundFailure, type TelegramInbound } from '../telegram/service.ts';
import { BotOwnershipError } from '../telegram/ownership.ts';
import { TelegramApiError } from '../telegram/client.ts';
import { notificationsReason } from '../telegram/availability.ts';
type TelegramEnv = { Variables: { telegram?: TelegramInbound } };
export function createTelegramRoutes(resolve: (projectId: string | undefined) => Promise<TelegramInbound | undefined>,
  unavailable: () => TelegramInboundStateResponse['reason'],
  validateProject: (projectId: string | undefined) => Promise<void> = async () => {}) {
  const domainError = (error: string, code: string): TelegramDomainError => ({ error, code });
  // `unavailable` names the task-control reason; notifications and their setup survive a flag_off.
  const notifications = () => notificationsReason(unavailable());
  const gate: MiddlewareHandler<TelegramEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const projectId = c.req.param('projectId');
    await validateProject(projectId);
    if (!notifications()) c.set('telegram', await resolve(projectId));
    if (c.req.method !== 'GET' && notifications()) throw new TelegramInboundFailure(503, notifications()!);
    await next();
  };
  /** Approving, editing or revoking people is task control; the service gates the rest by scope. */
  const taskControl: MiddlewareHandler<TelegramEnv> = async (_c, next) => {
    if (unavailable()) throw new TelegramInboundFailure(503, unavailable()!);
    await next();
  };
  const service = (value: TelegramInbound | undefined): TelegramInbound => {
    if (!value) throw new TelegramInboundFailure(503, notifications() ?? 'unavailable'); return value;
  };
  const withheld = (): TelegramInboundStateResponse => {
    const reason = unavailable() ?? 'unavailable', off = notifications() ?? 'unavailable';
    return { available: false, reason, notifications: { available: false, reason: off }, taskControl: { available: false, reason },
      receivers: [], bots: [], grants: [] };
  };
  return new Hono<TelegramEnv>()
    .onError((error, c) => {
      if (error instanceof TelegramInboundFailure) return c.json(domainError(error.code, error.code), error.status);
      if (error instanceof BotOwnershipError) return c.json(domainError('Bot is owned elsewhere or its binding changed.', 'bot_conflict'), 409);
      if (error instanceof TelegramApiError && error.status === 429) {
        c.header('Retry-After', String(Math.min(60, Math.max(1, error.retryAfter ?? 1))));
        return c.json(domainError('Telegram rate limit; try again later.', 'rate_limited'), 429);
      }
      if (error instanceof TelegramApiError && error.status === 401) return c.json(domainError('invalid_token', 'invalid_token'), 401);
      return c.json(domainError('Telegram is temporarily unavailable.', 'unavailable'), 503);
    })
    .use('/telegram', gate).use('/telegram/*', gate)
    .get('/telegram', async c => {
      const inbound = c.get('telegram');
      await inbound?.refreshDiagnostics();
      // Configuration is withheld whenever Telegram is unusable (hosted, webhooks off); the reasons stay readable.
      const result: TelegramInboundStateResponse = notifications() || !inbound ? withheld() : inbound.list();
      return c.json(result);
    })
    // Hosted or flag-off: reads answer empty, never the stored journal or pairing state.
    .get('/telegram/activity', queryZodValidator(telegramInboundActivityQuerySchema), c => {
      const inbound = c.get('telegram');
      return c.json(unavailable() || !inbound ? { entries: [] } : inbound.activity(c.req.valid('query')));
    })
    .post('/telegram/setup', jsonZodValidator(telegramSetupBeginSchema), async c => c.json(await service(c.get('telegram')).beginSetup(c.req.valid('json')), 201))
    .get('/telegram/setup/:id', paramZodValidator(telegramInboundIdParamSchema), c => {
      const inbound = c.get('telegram');
      if (notifications() || !inbound) throw new TelegramInboundFailure(404, 'pairing_expired');
      return c.json(inbound.setupStatus(c.req.valid('param').id));
    })
    .post('/telegram/setup/:id/activate', paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramSetupActivateSchema),
      async c => c.json(await service(c.get('telegram')).activateSetup(c.req.valid('param').id, c.req.valid('json'))))
    .delete('/telegram/setup/:id', paramZodValidator(telegramInboundIdParamSchema), async c => c.json(await service(c.get('telegram')).cancelSetup(c.req.valid('param').id)))
    .patch('/telegram/receivers/:id', taskControl, paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramInboundReceiverPatchSchema),
      async c => c.json(await service(c.get('telegram')).setEnabled(c.req.valid('param').id, c.req.valid('json'))))
    .patch('/telegram/grants/:id', taskControl, paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramInboundGrantPatchSchema),
      async c => c.json(await service(c.get('telegram')).permissions(c.req.valid('param').id, c.req.valid('json'))))
    .delete('/telegram/grants/:id', taskControl, paramZodValidator(telegramInboundIdParamSchema), queryZodValidator(telegramInboundRevisionQuerySchema),
      async c => c.json(await service(c.get('telegram')).revoke(c.req.valid('param').id, c.req.valid('query').expectedRevision)))
    .delete('/telegram/bots/:botId/binding', paramZodValidator(telegramInboundBotParamSchema), queryZodValidator(telegramInboundRevisionQuerySchema),
      async c => c.json(await service(c.get('telegram')).disconnect(c.req.valid('param').botId, c.req.valid('query').expectedRevision)))
    .post('/telegram/bots/:botId/reset', paramZodValidator(telegramInboundBotParamSchema), jsonZodValidator(telegramInboundResetSchema),
      async c => c.json(await service(c.get('telegram')).reset(c.req.valid('param').botId, c.req.valid('json').expectedRevision)))
    .all('/telegram/*', c => c.json(domainError('Unknown Telegram route.', 'not_found'), 404));
}

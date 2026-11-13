import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { extensionChatRouteParamsSchema, type chatSchemas, type ChatInboundStateResponse, type ChatDomainError } from '@open-mercato/cezar-contract';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { ChatInboundFailure, type ChatInbound } from '../chat/service.ts';
import { ChatTransportError, type ChatProviderId } from '../chat/provider.ts';
import { BotOwnershipError } from '../chat/ownership.ts';
import { notificationsReason } from '../chat/availability.ts';
import type { ChatBindings } from '../chat/bindings.ts';

type ChatEnv = { Variables: { chat?: ChatInbound } };
/** The project-scoped chat family every provider mounts (Telegram, Slack, Discord, extension chats). */
export function createChatRoutes<const P extends ChatProviderId>(provider: P, resolve: (projectId: string | undefined, params?: Record<string, string>) => Promise<ChatInbound | undefined>,
  unavailable: () => ChatInboundStateResponse['reason'], schemas: ReturnType<typeof chatSchemas>,
  validateProject: (projectId: string | undefined) => Promise<void> = async () => {}) {
  // An extension chat's `provider` is a route template, never something to show a user.
  const name = provider.startsWith('extensions/') ? 'chat provider' : provider;
  const label = `${name[0]!.toUpperCase()}${name.slice(1)}`;
  const domainError = (error: string, code: string): ChatDomainError => ({ error, code });
  // `unavailable` names the task-control reason; notifications and their setup survive a flag_off.
  const notifications = () => notificationsReason(unavailable());
  const gate: MiddlewareHandler<ChatEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const projectId = c.req.param('projectId');
    // A malformed id is the caller's error (400), not a provider outage.
    if (provider.startsWith('extensions/') && !extensionChatRouteParamsSchema.safeParse(c.req.param()).success) return c.json(domainError('Invalid extension chat route.', 'invalid_request'), 400);
    await validateProject(projectId);
    if (!notifications()) c.set('chat', await resolve(projectId, c.req.param()));
    if (c.req.method !== 'GET' && notifications()) throw new ChatInboundFailure(503, notifications()!);
    await next();
  };
  const service = (value: ChatInbound | undefined): ChatInbound => {
    if (!value) throw new ChatInboundFailure(503, notifications() ?? 'unavailable'); return value;
  };
  const withheld = (): ChatInboundStateResponse => {
    const reason = unavailable() ?? 'unavailable', off = notifications() ?? 'unavailable';
    return { available: false, reason, notifications: { available: false, reason: off }, taskControl: { available: false, reason },
      receivers: [], bots: [], grants: [] };
  };
  return new Hono<ChatEnv>()
    .onError((error, c) => {
      if (error instanceof ChatInboundFailure) return c.json(domainError(error.code, error.code), error.status);
      if (error instanceof BotOwnershipError) return c.json(domainError('Bot is owned elsewhere or its binding changed.', 'bot_conflict'), 409);
      if (error instanceof ChatTransportError && error.failure.kind === 'rate_limited') {
        c.header('Retry-After', String(Math.min(60, Math.max(1, (error.failure.retryAfterMs ?? 1000) / 1000))));
        return c.json(domainError(`${label} rate limit; try again later.`, 'rate_limited'), 429);
      }
      if (error instanceof ChatTransportError && error.failure.kind === 'auth') return c.json(domainError('invalid_token', 'invalid_token'), 401);
      return c.json(domainError(`${label} is temporarily unavailable.`, 'unavailable'), 503);
    })
    .use(`/${provider}` as const, gate).use(`/${provider}/*` as const, gate)
    .get(`/${provider}` as const, async c => {
      const inbound = c.get('chat');
      await inbound?.refreshDiagnostics();
      // Configuration is withheld whenever chat is unusable (hosted, webhooks off); the reasons stay readable.
      const result: ChatInboundStateResponse = notifications() || !inbound ? withheld() : inbound.list();
      return c.json(result);
    })
    // Hosted or flag-off: reads answer empty, never the stored journal or pairing state.
    .get(`/${provider}/activity` as const, queryZodValidator(schemas.chatInboundActivityQuerySchema), c => {
      const inbound = c.get('chat');
      return c.json(unavailable() || !inbound ? { entries: [] } : inbound.activity(c.req.valid('query')));
    })
    .post(`/${provider}/setup` as const, jsonZodValidator(schemas.chatSetupBeginSchema), async c => c.json(await service(c.get('chat')).beginSetup(c.req.valid('json')), 201))
    .get(`/${provider}/setup/:id` as const, paramZodValidator(schemas.chatInboundIdParamSchema), c => {
      const inbound = c.get('chat');
      if (notifications() || !inbound) throw new ChatInboundFailure(404, 'pairing_expired');
      return c.json(inbound.setupStatus(c.req.valid('param').id));
    })
    .post(`/${provider}/setup/:id/activate` as const, paramZodValidator(schemas.chatInboundIdParamSchema), jsonZodValidator(schemas.chatSetupActivateSchema),
      async c => c.json(await service(c.get('chat')).activateSetup(c.req.valid('param').id, c.req.valid('json'))))
    .delete(`/${provider}/setup/:id` as const, paramZodValidator(schemas.chatInboundIdParamSchema), async c => c.json(await service(c.get('chat')).cancelSetup(c.req.valid('param').id)))
    .patch(`/${provider}/receivers/:id` as const, paramZodValidator(schemas.chatInboundIdParamSchema), jsonZodValidator(schemas.chatInboundReceiverPatchSchema),
      async c => c.json(await service(c.get('chat')).setEnabled(c.req.valid('param').id, c.req.valid('json'))))
    .patch(`/${provider}/grants/:id` as const, paramZodValidator(schemas.chatInboundIdParamSchema), jsonZodValidator(schemas.chatInboundGrantPatchSchema),
      async c => c.json(await service(c.get('chat')).permissions(c.req.valid('param').id, c.req.valid('json'))))
    .delete(`/${provider}/grants/:id` as const, paramZodValidator(schemas.chatInboundIdParamSchema), queryZodValidator(schemas.chatInboundRevisionQuerySchema),
      async c => c.json(await service(c.get('chat')).revoke(c.req.valid('param').id, c.req.valid('query').expectedRevision)))
    .delete(`/${provider}/bots/:botId/binding` as const, paramZodValidator(schemas.chatInboundBotParamSchema), queryZodValidator(schemas.chatInboundRevisionQuerySchema),
      async c => c.json(await service(c.get('chat')).disconnect(c.req.valid('param').botId, c.req.valid('query').expectedRevision)))
    .post(`/${provider}/bots/:botId/reset` as const, paramZodValidator(schemas.chatInboundBotParamSchema), jsonZodValidator(schemas.chatInboundResetSchema),
      async c => c.json(await service(c.get('chat')).reset(c.req.valid('param').botId, c.req.valid('json').expectedRevision)))
    .all(`/${provider}/*` as const, c => c.json(domainError(`Unknown ${name} route.`, 'not_found'), 404));
}

/** Workspace bot-binding diagnostics; exact paths, mounted before the project's /<provider>/* catch-all. */
export function createChatBindingRoutes<const P extends string>(provider: P, bindings: ChatBindings | ((params: Record<string, string>) => ChatBindings), schemas: ReturnType<typeof chatSchemas>,
  /** Validates the provider path params (extension chats); a decoded `%2F` must never reach the filesystem (S1). */
  providerParams: z.ZodType<Record<string, string>> = z.object({})) {
  const domainError = (error: string, code: string): ChatDomainError => ({ error, code });
  const select = (params: Record<string, string>) => typeof bindings === 'function' ? bindings(params) : bindings;
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ChatInboundFailure) return c.json(domainError(error.code, error.code), error.status);
      if (error instanceof BotOwnershipError) return c.json(domainError('Bot has an active owner or a changed binding.', 'bot_conflict'), 409);
      return c.json(domainError('Bot bindings are temporarily unavailable.', 'unavailable'), 503);
    })
    // As middleware: a route validator would add `param` to the built-ins' client type. DELETE validates its own params.
    .use(`/${provider}/bot-bindings` as const, paramZodValidator(providerParams))
    .get(`/${provider}/bot-bindings` as const, async c => {
      c.header('Cache-Control', 'no-store'); return c.json(await select(c.req.param() as Record<string, string>).list());
    })
    .delete(`/${provider}/bot-bindings/:botId` as const, paramZodValidator(schemas.chatInboundBotParamSchema), queryZodValidator(schemas.chatOrphanReleaseQuerySchema), async c => {
      const { botId, ...params } = c.req.valid('param');
      c.header('Cache-Control', 'no-store'); return c.json(await select(params as Record<string, string>).release(botId, c.req.valid('query').expectedRevision));
    });
}


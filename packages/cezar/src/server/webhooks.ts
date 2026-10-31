import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  createWebhookSchema, updateWebhookSchema, webhookReceiverParamsSchema, webhookDeliveryParamsSchema,
  webhookRevisionSchema, webhookActivationSchema, webhookRotationSchema, webhookOperationSchema, webhookReplaySchema,
  webhookNoticeAcknowledgementSchema, webhookHistoryQuerySchema, webhookDeliveriesQuerySchema,
} from '@open-mercato/cezar-contract';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import type { WebhookService } from '../webhooks/service.ts';
import { webhookPlatformSupported, WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE } from '../webhooks/platform.ts';
import { WebhookStateError } from '../webhooks/endpoints.ts';
type WebhookEnv = { Variables: { project: ProjectContext; webhookService: WebhookService } };
export function createWebhookRoutes(resolve: (context: ProjectContext) => Promise<WebhookService>) {
  const gate: MiddlewareHandler<WebhookEnv> = async (c, next) => {
    if (!webhookPlatformSupported()) return c.json({ error: WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE }, 409);
    if (process.env.CEZ_WEBHOOKS !== '1') return c.json({ error: 'Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar' }, 409);
    if (!c.get('webhookService')) c.set('webhookService', await resolve(c.get('project')));
    c.header('Cache-Control', 'no-store');
    await next();
  };
  return new Hono<WebhookEnv>()
    .onError((error, c) => {
      if (error instanceof WebhookStateError) {
        if (error.retryAt !== undefined) c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))));
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: 'Webhooks are temporarily unavailable. Try again, or restart cezar if it keeps happening.' }, 503);
    })
    .use('/webhooks', gate).use('/webhooks/*', gate)
    .get('/webhooks', c => c.json(c.get('webhookService').list()))
    .get('/webhooks/history', queryZodValidator(webhookHistoryQuerySchema), c => c.json(c.get('webhookService').historyPage(c.req.valid('query'))))
    .get('/webhooks/events', c => {
      c.header('X-Accel-Buffering', 'no'); c.header('Cache-Control', 'no-cache, no-transform');
      const service = c.get('webhookService');
      const response = streamSSE(c, async stream => {
        let pending: number | undefined, writing = false, closed = false;
        const flush = async () => {
          if (writing || closed) return; writing = true;
          try { while (pending !== undefined && !closed) { const sequence = pending; pending = undefined; await stream.writeSSE({ event: 'change', data: JSON.stringify({ changeSequence: sequence }) }); } }
          finally { writing = false; }
        };
        const listener = (sequence: number) => { pending = sequence; void flush().catch(() => stream.close()); };
        service.on('change', listener);
        let done!: () => void; const finished = new Promise<void>(resolveDone => { done = resolveDone; });
        const close = () => { closed = true; service.off('change', listener); done(); };
        service.once('dispose', close); stream.onAbort(close);
        const heartbeat = setInterval(() => { if (!writing && !closed) void stream.writeSSE({ event: 'ping', data: '{}' }).catch(close); }, 15000);
        heartbeat.unref();
        try { await stream.writeSSE({ event: 'resync', data: JSON.stringify({ changeSequence: service.list().changeSequence }) }); if (stream.aborted) close(); await finished; }
        finally { clearInterval(heartbeat); close(); service.off('dispose', close); }
      });
      response.headers.set('Cache-Control', 'no-cache, no-transform'); response.headers.set('X-Accel-Buffering', 'no');
      return response;
    })
    .post('/webhooks', jsonZodValidator(createWebhookSchema), async c => c.json(await c.get('webhookService').create(c.req.valid('json')), 201))
    .post('/webhooks/notice/acknowledge', jsonZodValidator(webhookNoticeAcknowledgementSchema), async c => { await c.get('webhookService').acknowledge(c.req.valid('json').expectedChangeSequence); return c.json({ ok: true as const }); })
    .post('/webhooks/deliveries/:deliveryId/retry', paramZodValidator(webhookDeliveryParamsSchema), jsonZodValidator(webhookOperationSchema), async c => c.json(await c.get('webhookService').retry(c.req.valid('param').deliveryId, c.req.valid('json'))))
    .post('/webhooks/deliveries/:deliveryId/replay', paramZodValidator(webhookDeliveryParamsSchema), jsonZodValidator(webhookReplaySchema), async c => { const { confirmed: _, ...input } = c.req.valid('json'); return c.json(await c.get('webhookService').replay(c.req.valid('param').deliveryId, input)); })
    .get('/webhooks/:id/deliveries', paramZodValidator(webhookReceiverParamsSchema), queryZodValidator(webhookDeliveriesQuerySchema), c => c.json(c.get('webhookService').deliveryPage(c.req.valid('param').id, c.req.valid('query'))))
    .get('/webhooks/:id/activity', paramZodValidator(webhookReceiverParamsSchema), c => c.json(c.get('webhookService').activityPage(c.req.valid('param').id)))
    .patch('/webhooks/:id', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(updateWebhookSchema), async c => c.json({ receiver: await c.get('webhookService').update(c.req.valid('param').id, c.req.valid('json')) }))
    .delete('/webhooks/:id', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(webhookRevisionSchema), async c => { await c.get('webhookService').delete(c.req.valid('param').id, c.req.valid('json').expectedRevision); return c.json({ ok: true as const }); })
    .post('/webhooks/:id/test', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(webhookOperationSchema), async c => c.json(await c.get('webhookService').test(c.req.valid('param').id, c.req.valid('json'))))
    .post('/webhooks/:id/activate', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(webhookActivationSchema), async c => c.json({ receiver: await c.get('webhookService').activate(c.req.valid('param').id, c.req.valid('json').expectedRevision) }))
    .post('/webhooks/:id/pause', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(webhookRevisionSchema), async c => c.json({ receiver: await c.get('webhookService').pause(c.req.valid('param').id, c.req.valid('json').expectedRevision) }))
    .post('/webhooks/:id/resume', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(webhookActivationSchema), async c => c.json({ receiver: await c.get('webhookService').resume(c.req.valid('param').id, c.req.valid('json').expectedRevision) }))
    .post('/webhooks/:id/rotate-secret', paramZodValidator(webhookReceiverParamsSchema), jsonZodValidator(webhookRotationSchema), async c => c.json(await c.get('webhookService').rotate(c.req.valid('param').id, c.req.valid('json').expectedRevision, c.req.valid('json').mode)));
}

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { webhookSecretResponseSchema, webhookDeliveriesPageSchema } from '@open-mercato/cezar-contract';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { verifyWebhook } from '../webhooks/signing.ts';
import { createWebhookRoutes } from './webhooks.ts';
import type { ProjectContext } from './project-context.ts';

afterEach(() => vi.unstubAllEnvs());
it.each(['/api/v1', '/api/v1/p/project'])('creates and tests a real local receiver through %s', async prefix => {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(tmpdir(), 'webhook-loopback-api-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  let secret = '', verified = false;
  const receiverServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      verified = verifyWebhook(String(request.headers['webhook-id']), Number(request.headers['webhook-timestamp']),
        Buffer.concat(chunks).toString(), String(request.headers['webhook-signature']), [secret], Math.floor(Date.now() / 1000));
      response.writeHead(verified ? 204 : 401); response.end();
    });
  });
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] });
  try {
    await new Promise<void>(resolve => receiverServer.listen(0, '127.0.0.1', resolve));
    const { port } = receiverServer.address() as { port: number };
    const context = { id: 'project', root } as ProjectContext;
    const family = createWebhookRoutes(project => coordinator.get(project.id, project.root));
    const app = new Hono<{ Variables: { project: ProjectContext } }>()
      .use('*', async (c, next) => { c.set('project', context); await next(); })
      .route('/api/v1', family).route('/api/v1/p/:projectId', family);
    const post = (path: string, body: unknown) => app.request(`${prefix}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const created = await post('/webhooks', { name: 'Local receiver', url: `http://127.0.0.1:${port}/webhook`, allowLocalNetwork: true });
    expect(created.status).toBe(201);
    const data = webhookSecretResponseSchema.parse(await created.json()); secret = data.secret;
    const { receiver } = data;
    const test = await post(`/webhooks/${receiver.id}/test`, {
      expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'loopback-test',
    });
    expect(test.status).toBe(200);
    await (await coordinator.get('project', root)).tick();
    expect(verified).toBe(true);
    const page = await app.request(`${prefix}/webhooks/${receiver.id}/deliveries`);
    expect(page.status).toBe(200);
    expect(webhookDeliveriesPageSchema.parse(await page.json()).items[0]).toMatchObject({ status: 'delivered', httpStatus: 204, attempts: 1 });
    expect((await app.request(`${prefix}/webhooks`)).status).toBe(200);
  } finally {
    await coordinator.dispose(); receiverServer.closeAllConnections();
    await new Promise<void>(resolve => receiverServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

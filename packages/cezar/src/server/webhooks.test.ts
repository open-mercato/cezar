import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookRoutes } from './webhooks.ts';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { webhookListSchema, webhookSecretResponseSchema, webhookDeliveriesPageSchema } from '@open-mercato/cezar-contract';
import type { ProjectContext } from './project-context.ts';
const roots: string[] = [], coordinators: WebhookCoordinator[] = [];
afterEach(async () => { for (const coordinator of coordinators.splice(0)) await coordinator.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'webhook-api-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], dryRun: true }); coordinators.push(coordinator);
  const project = { id: 'project', root } as ProjectContext;
  const family = createWebhookRoutes(context => coordinator.get(context.id, context.root));
  const app = new Hono<{ Variables: { project: ProjectContext } }>().use('*', async (c, next) => { c.set('project', project); await next(); }).route('/api/v1', family).route('/api/v1/p/:projectId', family);
  return { app, coordinator };
}
describe('webhook route contract', () => {

  it.each(['freebsd', 'sunos'])('rejects unsupported %s before resolving storage', async platform => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const resolve = vi.fn().mockRejectedValue(new Error('must not open storage'));
    const app = createWebhookRoutes(resolve);
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      for (const flag of ['', '0', 'true', '1']) {
        vi.stubEnv('CEZ_WEBHOOKS', flag);
        for (const [method, path] of [
          ['GET', '/webhooks'], ['GET', '/webhooks/history'], ['GET', '/webhooks/events'],
          ['POST', '/webhooks'], ['PATCH', '/webhooks/receiver'], ['DELETE', '/webhooks/receiver'],
          ['POST', '/webhooks/receiver/test'],
        ]) {
          const response = await app.request(path!, { method });
          expect(response.status).toBe(409);
          const body = z.object({ error: z.string() }).strict().parse(await response.json());
          expect(body.error).toMatch(/unsupported.*platform/i);
          expect(body.error).toContain('Linux');
          expect(body.error).not.toContain('CEZ_WEBHOOKS=1');
        }
      }
      expect(resolve).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', original); }
  });
  it('projects bounded notice and delivery availability through both route aliases', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const { app } = setup();
    const created = await app.request('/api/v1/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops', url: 'https://example.com/private?token=synthetic' }) });
    const { receiver } = webhookSecretResponseSchema.parse(await created.json());
    const tested = await app.request(`/api/v1/webhooks/${receiver.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, deliveryRevision: 1, operationId: 'projection' }) });
    expect(tested.status).toBe(200);
    const page = webhookDeliveriesPageSchema.parse(await (await app.request(`/api/v1/p/project/webhooks/${receiver.id}/deliveries`)).json());
    expect(page.items[0]).toMatchObject({ payloadAvailability: 'retained', taskAvailability: 'not_applicable', replayUnavailableReason: 'receiver_inactive' });
    const removed = await app.request(`/api/v1/webhooks/${receiver.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 2 }) });
    expect(removed.status).toBe(200);
    const direct = await (await app.request('/api/v1/webhooks')).json();
    expect(await (await app.request('/api/v1/p/project/webhooks')).json()).toEqual(direct);
    expect(webhookListSchema.parse(direct).notice).toMatchObject({ receiverId: receiver.id, receiverName: 'Ops', source: 'cockpit/api', destination: 'https://example.com/…' });
    expect(JSON.stringify(direct)).not.toContain('synthetic');
  });
  it('cannot read or mutate another project receiver even with a known identifier', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const alpha = setup(), beta = setup();
    const created = await alpha.app.request('/api/v1/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Alpha only', url: 'https://example.com' }) });
    const { receiver } = webhookSecretResponseSchema.parse(await created.json());
    expect((await beta.app.request(`/api/v1/webhooks/${receiver.id}/deliveries`)).status).toBe(404);
    expect((await beta.app.request(`/api/v1/webhooks/${receiver.id}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: receiver.revision }) })).status).toBe(404);
    expect(webhookListSchema.parse(await (await beta.app.request('/api/v1/webhooks')).json()).receivers).toHaveLength(0);
    expect(webhookListSchema.parse(await (await alpha.app.request('/api/v1/webhooks')).json()).receivers).toHaveLength(1);
  });
  it('gates every registered route before storage and rejects strict mutation bodies', async () => {
    const { app, coordinator } = setup();
    expect((await app.request('/api/v1/webhooks')).status).toBe(409); expect(coordinator.count()).toBe(0);
    vi.stubEnv('CEZ_WEBHOOKS', '1');
    const response = await app.request('/api/v1/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops', url: 'https://example.com', projectId: 'foreign' }) });
    expect(response.status).toBe(400);
  });
  it.each(['/api/v1', '/api/v1/p/project', '/api/v1/p/default'])('accepts receiver parameters through %s', async prefix => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const { app } = setup();
    const response = await app.request(`${prefix}/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops', url: 'https://example.com' }) });
    const { receiver } = webhookSecretResponseSchema.parse(await response.json());
    const test = await app.request(`${prefix}/webhooks/${receiver.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'alias-test' }) });
    expect(test.status).toBe(200);
    expect((await app.request(`${prefix}/webhooks/${receiver.id}/deliveries`)).status).toBe(200);
  });
  it('returns exact schemas, one-time no-store secrets and revision conflicts', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const { app } = setup();
    const response = await app.request('/api/v1/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops', url: 'https://example.com/path?private=hidden' }) });
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toContain('no-store');
    const created = webhookSecretResponseSchema.parse(await response.json());
    const listed = webhookListSchema.parse(await (await app.request('/api/v1/webhooks')).json());
    expect(JSON.stringify(listed)).not.toContain(created.secret); expect(JSON.stringify(listed)).not.toContain('private=hidden');
    const conflict = await app.request(`/api/v1/webhooks/${created.receiver.id}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 9, confirmed: true }) });
    expect(conflict.status).toBe(409);
    expect((await app.request('/api/v1/webhooks/history')).status).toBe(200);
  });
});

it('reports a retained private URL incompatible with a format edit as a configuration conflict', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); const { app } = setup();
  const headers = { 'content-type': 'application/json' };
  const response = await app.request('/api/v1/webhooks', { method: 'POST', headers, body: JSON.stringify({ name: 'Custom', url: 'https://example.com/secret-path' }) });
  const { receiver } = webhookSecretResponseSchema.parse(await response.json());
  const edited = await app.request(`/api/v1/webhooks/${receiver.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Slack', format: 'slack.v1', expectedRevision: receiver.revision }) });
  expect(edited.status).toBe(409);
  const error = await edited.text();
  expect(error).toContain('destination');
  expect(error).not.toContain('secret-path');
  expect(error).not.toContain('storage');
});

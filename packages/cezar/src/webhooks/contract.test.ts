import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contract from '@open-mercato/cezar-contract';

// Assert exports before calling so RED reports the missing contract rather than an import error.
const schemas = contract as unknown as Record<string, z.ZodType>;
function schema(name: string): z.ZodType {
  expect(schemas[name], `Missing contract ${name}`).toBeDefined();
  return schemas[name]!;
}
const base = {
  id: 'evt_9f664930-5157-4938-bf64-8cf9105e7990', schemaVersion: 1,
  occurredAt: '2026-10-13T12:00:00.000Z', sequence: 1,
  source: { instanceId: 'inst_76a31bca', projectId: 'customer-api', mode: 'local' },
  task: { id: 'task-1', status: 'done', previousStatus: 'running' },
};
describe('outbound webhook contracts', () => {
  it('defaults creation to Minimal and root tasks plus child questions', () => {
    expect(schema('createWebhookSchema').parse({ name: 'Operations', url: 'https://example.com/hooks' }))
      .toMatchObject({ profile: 'minimal', preset: 'attention', scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false });
  });
  it('rejects owner overrides and non-http destinations', () => {
    const create = schema('createWebhookSchema');
    expect(create.safeParse({ name: 'Ops', url: 'https://example.com', projectId: 'foreign' }).success).toBe(false);
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com/#fragment']) {
      expect(create.safeParse({ name: 'Ops', url }).success).toBe(false);
    }
  });
  it.each(['http://127.0.0.1:8788/webhook', 'http://localhost:8788/webhook', 'http://[::1]:8788/webhook', 'http://192.168.1.10/hook', 'http://receiver:8788/hook'])(
    'accepts local receiver syntax for create and edit: %s', url => {
      expect(contract.createWebhookSchema.safeParse({ name: 'Ops', url, allowLocalNetwork: true }).success).toBe(true);
      expect(contract.updateWebhookSchema.safeParse({ name: 'Ops', url, expectedRevision: 1, allowLocalNetwork: true }).success).toBe(true);
    },
  );
  it.each(['ftp://localhost/hook', 'http://user:password@localhost/hook', 'http://127.0.0.1/hook#', 'http://[::1]/hook#fragment', 'http://local host/hook', 'http://localhost:99999/hook'])(
    'rejects unsafe or malformed local receiver syntax: %s', url => {
      expect(contract.createWebhookSchema.safeParse({ name: 'Ops', url }).success).toBe(false);
      expect(contract.updateWebhookSchema.safeParse({ name: 'Ops', url, expectedRevision: 1 }).success).toBe(false);
    },
  );
  it('requires selected events for Custom and rejects arbitrary event names', () => {
    const create = schema('createWebhookSchema');
    expect(create.safeParse({ name: 'Ops', url: 'https://example.com', preset: 'custom', events: [] }).success).toBe(false);
    expect(create.safeParse({ name: 'Ops', url: 'https://example.com', preset: 'custom', events: ['task.finished'] }).success).toBe(true);
    expect(create.safeParse({ name: 'Ops', url: 'https://example.com', events: ['task.prompt'] }).success).toBe(false);
  });
  it('requires revisions and an operation id for manual delivery operations', () => {
    const operation = schema('webhookOperationSchema');
    expect(operation.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(operation.safeParse({ expectedRevision: 1, deliveryRevision: 2, operationId: 'operation-1' }).success).toBe(true);
    expect(operation.safeParse({ expectedRevision: 1, deliveryRevision: 2, operationId: '../other' }).success).toBe(false);
  });
  it('requires a scheduled-failure deadline without leaking it into manual events', () => {
    const event = schema('webhookEventSchema');
    const failure = { ...base, type: 'task.failed', task: { ...base.task, status: 'failed' }, data: { episodeId: 'episode-1', failedAt: base.occurredAt, disposition: 'scheduled' } };
    expect(event.safeParse(failure).success).toBe(false);
    expect(event.safeParse({ ...failure, data: { ...failure.data, autoResumeAt: base.occurredAt } }).success).toBe(true);
    expect(event.safeParse({ ...failure, data: { ...failure.data, disposition: 'manual', autoResumeAt: base.occurredAt } }).success).toBe(false);
  });
  it('rejects task status mismatches and the reserved project alias', () => {
    const event = schema('webhookEventSchema');
    const finished = { ...base, type: 'task.finished', data: { resolution: 'completed', finishedAt: base.occurredAt } };
    expect(event.safeParse(finished).success).toBe(true);
    expect(event.safeParse({ ...finished, task: { ...base.task, status: 'running' } }).success).toBe(false);
    expect(event.safeParse({ ...finished, source: { ...base.source, projectId: 'default' } }).success).toBe(false);
    expect(event.safeParse({ ...finished, task: { ...base.task, title: 'x'.repeat(513) } }).success).toBe(false);
    expect(event.safeParse({ ...finished, prompt: 'private' }).success).toBe(false);
  });
  it('keeps tests synthetic, forbidding caller text and source metadata', () => {
    const event = schema('webhookEventSchema');
    const test = { id: base.id, schemaVersion: 1, occurredAt: base.occurredAt, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } };
    expect(event.safeParse(test).success).toBe(true);
    for (const extra of [{ source: base.source }, { task: base.task }, { sequence: 1 }, { name: 'exfil' }]) {
      expect(event.safeParse({ ...test, ...extra }).success).toBe(false);
    }
    expect(event.safeParse({ ...test, data: { ...test.data, message: 'exfil' } }).success).toBe(false);
  });
  it('exports a JSON-schema convertible discriminated union', () => {
    const json = z.toJSONSchema(schema('webhookEventSchema'));
    expect(json).toHaveProperty('oneOf');
    expect(JSON.stringify(json)).not.toContain('prompt');
  });
  it('bounds paged queries and refuses cross-project filters', () => {
    const query = schema('webhookDeliveriesQuerySchema');
    expect(query.safeParse({ limit: '101' }).success).toBe(false);
    expect(query.safeParse({ cursor: 'x'.repeat(4097) }).success).toBe(false);
    expect(query.safeParse({ projectId: 'foreign' }).success).toBe(false);
    expect(query.parse({ limit: '20', taskId: 'deleted-task' })).toMatchObject({ limit: 20, taskId: 'deleted-task' });
  });
});

describe('destination hostname bounds', () => {
  const overlong = Array(5).fill('a'.repeat(60)).join('.');
  const expanded = Array(4).fill('é'.repeat(58)).join('.');
  it.each([overlong, expanded, Array(4).fill('a'.repeat(63)).join('.') + '.'])('rejects oversized normalized host %s on create and update', host => {
    const url = 'https://' + host + '/hook';
    expect(new URL(url).hostname.length).toBeGreaterThan(255);
    expect.soft(contract.createWebhookSchema.safeParse({ name: 'Ops', url }).success).toBe(false);
    expect(contract.updateWebhookSchema.safeParse({ name: 'Ops', url, expectedRevision: 1 }).success).toBe(false);
  });
});

it('accepts the existing 255-byte host bound and omitted URL edits', () => {
  const url = 'https://' + Array(4).fill('a'.repeat(63)).join('.') + ':443/hook';
  expect(contract.createWebhookSchema.safeParse({ name: 'Ops', url }).success).toBe(true);
  expect(contract.updateWebhookSchema.safeParse({ name: 'Ops', url, expectedRevision: 1 }).success).toBe(true);
  expect(contract.updateWebhookSchema.safeParse({ name: 'Ops', expectedRevision: 1 }).success).toBe(true);
});

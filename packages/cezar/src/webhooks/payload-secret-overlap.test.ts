import { afterEach, expect, it, vi } from 'vitest';
import { redactSource, renderPayload } from './payload.ts';
import type { WebhookSource } from './source.ts';

afterEach(() => vi.unstubAllEnvs());
it.each(['receivers', 'environment'] as const)('redacts combined %s prefixes before capture and rendering', kind => {
  const prefix = 'https://receiver.invalid/';
  const receiver = prefix + '?token=SYNTHETIC_PRIVATE_CAPABILITY';
  if (kind === 'environment') vi.stubEnv('TEST_RECEIVER_SECRET', prefix);
  const secrets = kind === 'environment' ? [receiver] : [prefix, receiver];
  const source: WebhookSource = {
    version: 1, id: 'evt_00000000-0000-4000-8000-000000000001', sequence: 1,
    installationId: 'inst_test', projectId: 'project', previousStatus: 'running',
    episodeId: 'task-1-1', type: 'task.failed', occurredAt: '2026-10-13T12:00:00Z', mode: 'local',
    snapshot: { id: 'task-1', status: 'failed', archived: false, continuation: 0,
      title: receiver, titleOrigin: 'user', error: 'Failed ' + receiver },
  };
  const durable = redactSource(source, secrets);
  expect(durable.snapshot.error).toBe('Failed [REDACTED]');
  expect(durable.snapshot.title).toBe('[REDACTED]');
  for (const item of [source, durable]) {
    const body = renderPayload(item, 'standard', secrets, { disposition: 'manual' });
    expect(body).not.toContain('SYNTHETIC_PRIVATE_CAPABILITY');
    expect(body).not.toContain('?token=');
  }
});

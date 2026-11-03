import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { telegramAnswerMode } from '../telegram/conversation.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import type { SendResult, WebhookSend } from './transport.ts';

const roots: string[] = [], services: WebhookService[] = [], stores: RunStore[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// 0.17/0.18 read the outbox with a strict question schema; an unknown key makes them reset webhook state.
it('keeps multiSelect out of the outbox and the Standard payload while the run record keeps it', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-outbox-shape-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar');
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const service = (await WebhookService.open({ root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [4317], scheduler: new WebhookScheduler(), now: () => Date.now(), send }))!;
  services.push(service);
  const store = RunStore.open(dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
  const created = await service.create({ name: 'Json', url: 'https://example.com/hook', profile: 'standard', graceSeconds: 0 });
  await service.activate(created.receiver.id, 1);
  const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
  store.updateRun(run.id, { status: 'running' });
  const attentionRequest = { requestId: 'question-1', askedAt: '2026-10-13T12:00:00.000Z', questions: [{ question: 'Which targets?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true as const }] };
  store.updateRun(run.id, { status: 'waiting', attentionRequest });
  // Read before a tick admits the source and compacts the outbox.
  const outbox = readFileSync(join(dataDir, 'webhooks/outbox.ndjson'), 'utf8');
  expect(outbox).toContain('Which targets?');
  expect(outbox).not.toContain('"multiSelect"');
  await service.tick(); await service.tick();
  const body = send.mock.calls.map(([input]) => input.body).find(text => text.includes('task.attention_required'));
  expect(body).toBeDefined();
  expect(body).toContain('Which targets?');
  expect(body).not.toContain('multiSelect');
  const recorded = store.getRun(run.id)!;
  expect(recorded.attentionRequest?.questions[0]).toMatchObject({ multiSelect: true });
  expect(telegramAnswerMode(recorded)).toBe('multi_select');
});

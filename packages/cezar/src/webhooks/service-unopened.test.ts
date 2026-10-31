import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import type { SendResult, WebhookSend } from './transport.ts';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A project that is not opened in this process is still served by the webhook coordinator
 * (discovery starts the service without a RunManager). Rows a previous process left `running`
 * or `waiting` are old work, not a live owner: webhook ownership is exclusive, so the spec's
 * disk-only freshness rules apply. Treating those rows as "recovering" deferred every
 * attention/review/failure delivery until its 72 h expiry — the one scenario the feature exists
 * for (cezar was closed when the task failed) never notified.
 */
describe('unopened project disk state', () => {
  it('sends a manual failure and supersedes an old question while another run still looks live', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-unopened-'));
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const dataDir = join(root, '.ai/cezar');
    let now = Date.parse('2026-10-13T12:00:00Z');
    const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
    const options = {
      root, dataDir, projectId: 'project', mode: 'local' as const,
      serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send,
    };

    // First process: an active receiver captures a question and a failure, and leaves a
    // third run that still reads as `running` (the shape that used to force `recovering`).
    const store = RunStore.open(dataDir);
    const service = (await WebhookService.open(options))!;
    try {
      service.attach(store, { isActive: () => false }, true);
      const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com/hook', graceSeconds: 0 });
      await service.activate(receiver.id, 1);

      const waiting = store.createRun({ title: 'Waiting task', task: 'wait', workflow: 'quick-task', steps: [] });
      store.updateRun(waiting.id, {
        status: 'waiting',
        attentionRequest: { requestId: 'q-1', askedAt: new Date(now).toISOString(), questions: [{ question: 'Which one?' }] },
      });
      const failed = store.createRun({ title: 'Failed task', task: 'fail', workflow: 'quick-task', steps: [] });
      store.updateRun(failed.id, { status: 'failed', error: 'boom' });
      const live = store.createRun({ title: 'Live task', task: 'live', workflow: 'quick-task', steps: [] });
      store.updateRun(live.id, { status: 'running' });
      expect(service.endpoints.hasCapturingReceivers()).toBe(true);
    } finally {
      await service.dispose();
      store.flush();
    }

    // Second process: no store attached, so freshness must come from runs.json alone. The
    // 30-second failure grace has passed.
    now += 31_000;
    const reopened = (await WebhookService.open(options))!;
    try {
      await reopened.tick();
      expect(send).toHaveBeenCalledTimes(1);
      const rows = reopened.deliveries(reopened.list().receivers[0]!.id);
      expect(rows.find(row => row.eventType === 'task.failed')).toMatchObject({ status: 'delivered' });
      expect(rows.find(row => row.eventType === 'task.attention_required')).toMatchObject({ status: 'superseded' });
    } finally {
      await reopened.dispose();
    }
  });
});

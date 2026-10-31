import { execFileSync } from 'node:child_process';
import { realpathSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookService } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
import type { SendResult, WebhookSend } from './transport.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['retry', 'grace', 'probe'] as const)(
  'rechecks %s deadline after a real scheduler wait and sends once when due again',
  async kind => {
    vi.stubEnv('CEZ_WEBHOOKS', '1');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-timing-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const dataDir = join(root, '.ai/cezar');
    const start = Date.parse('2026-10-15T00:00:00Z');
    let now = start;
    const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 204 }));
    const scheduler = new WebhookScheduler();
    const service = (await WebhookService.open({
      root, dataDir, projectId: 'timing', mode: 'local', serverPorts: () => [],
      scheduler, now: () => now, send,
    }))!;
    const store = RunStore.open(dataDir);
    let release: (() => void) | undefined;
    try {
      service.attach(store, { isActive: () => false }, true);
      const { receiver } = await service.create({ name: 'Timing', url: 'https://receiver.invalid', graceSeconds: 60 });
      await service.activate(receiver.id, 1);
      if (kind === 'probe') {
        for (let i = 0; i < 10; i++) await service.endpoints.deliveryResult(receiver.id, 2, 1, 'transient', false);
      }
      const run = store.createRun({ title: 'Timing', task: 'Timing', workflow: 'w', steps: [] });
      store.updateRun(run.id, { status: kind === 'grace' ? 'waiting' : 'done' });
      if (kind === 'retry') send.mockResolvedValueOnce({
        kind: 'http', status: 429, retryAfter: new Date(start + 60000).toUTCString(),
      });
      await service.tick();
      const before = service.deliveries(receiver.id)[0]!;
      const deadline = kind === 'probe' ? Date.parse(service.list().receivers[0]!.nextProbeAt!)
        : kind === 'retry' ? Date.parse(before.nextAttemptAt!) : start + 60000;
      expect(deadline).toBe(start + (kind === 'probe' ? 900000 : 60000));
      const sentBefore = kind === 'retry' ? 1 : 0;
      expect(send).toHaveBeenCalledTimes(sentBefore);
      const limitsPath = join(dataDir, 'webhooks/limits.json');
      // A rejected claim must not consume the durable rate budget either.
      const limitsBefore = (() => { try { return readFileSync(limitsPath, 'utf8'); } catch { return undefined; } })();
      release = await scheduler.acquire('other-project', 'receiver.invalid');
      const acquire = scheduler.acquire.bind(scheduler);
      let queued!: () => void;
      const waiting = new Promise<void>(resolve => { queued = resolve; });
      const spy = vi.spyOn(scheduler, 'acquire').mockImplementation((...args) => {
        const result = acquire(...args); queued(); return result;
      });
      now = deadline;
      const tick = service.tick();
      await waiting;
      now = deadline - 30000;
      release!(); release = undefined;
      await tick;
      spy.mockRestore();
      expect(send).toHaveBeenCalledTimes(sentBefore);
      expect(service.deliveries(receiver.id)[0]).toEqual(before);
      const limitsAfter = (() => { try { return readFileSync(limitsPath, 'utf8'); } catch { return undefined; } })();
      expect(limitsAfter).toBe(limitsBefore);
      now = deadline - 1;
      await service.tick();
      expect(send).toHaveBeenCalledTimes(sentBefore);
      now = deadline;
      await service.tick();
      await service.tick();
      expect(send).toHaveBeenCalledTimes(sentBefore + 1);
      expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'delivered', attempts: sentBefore + 1 });
      if (kind === 'probe') expect(service.list().receivers[0]!.state).toBe('active');
    } finally {
      release?.();
      await service.dispose();
      store.flush();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('keeps a live test claim past its lease and records the actual result across restart', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-slow-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar');
  let now = Date.parse('2026-10-15T00:00:00Z');
  let finish!: (result: SendResult) => void;
  let entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const send = vi.fn(async (): Promise<SendResult> => {
    entered(); return new Promise(resolve => { finish = resolve; });
  });
  const options = { root, dataDir, projectId: 'slow', mode: 'local' as const, serverPorts: () => [],
    scheduler: new WebhookScheduler(), now: () => now, send };
  let service = (await WebhookService.open(options))!;
  let tick: Promise<void> | undefined;
  try {
    const { receiver } = await service.create({ name: 'Slow', url: 'https://receiver.invalid' });
    await service.test(receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'slow-test' });
    tick = service.tick(); await sending;
    now += 11000;
    await Promise.all([service.tick(), service.tick()]);
    finish({ kind: 'http', status: 204 }); await tick;
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'delivered', httpStatus: 204, attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(service.list().receivers[0]!.lastTest).toBe('success');
    await service.dispose();
    service = (await WebhookService.open(options))!;
    await service.tick();
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'delivered', httpStatus: 204 });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    finish?.({ kind: 'http', status: 204 }); await tick;
    await service.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

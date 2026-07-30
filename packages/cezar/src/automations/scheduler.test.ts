import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from './store.ts';
import { ProjectAutomationScheduler, WorkspaceAutomationScheduler } from './scheduler.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-scheduler-')); dirs.push(dir);
  const store = AutomationStore.open(dir);
  const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'one');
  return { store, definition };
}
const candidate = { eventId: 'event', event: 'issue.opened' as const, timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'Issue', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] };

describe('ProjectAutomationScheduler', () => {
  it('previews without cursor, receipt, or launch mutation', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never, launch });
    await scheduler.check(definition, 'preview');
    expect(store.state(definition.id)).toBeUndefined();
    expect(store.receipts()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({
      result: 'preview',
      reason: 'Bounded preview found 1 match; no tasks were launched.',
    });
  });

  it('reserves before launch and deduplicates the overlap window', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never, launch });
    await scheduler.check(definition);
    await scheduler.check(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.latestReceipts().get('one:event')).toMatchObject({ status: 'launched', runId: 'run' });
  });

  it('does not advance the cursor on failure and applies bounded backoff', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, { cursor: { timestamp: '2026-07-26T01:00:00.000Z' } });
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => { throw new Error('rate limited'); } } as never, launch: async () => ({ runId: 'unused' }) });
    await expect(scheduler.check(definition)).rejects.toThrow('rate limited');
    expect(store.state(definition.id)?.cursor?.timestamp).toBe('2026-07-26T01:00:00.000Z');
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 1, backoffUntil: expect.any(String) });
  });

  it('starts provider discovery from the durable cursor overlap', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, {
      cursor: { timestamp: '2026-07-26T01:00:00.000Z' },
    });
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      owner: 'acme',
      repo: 'demo',
      store,
      poller: { poll } as never,
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(poll).toHaveBeenCalledWith('acme', 'demo', definition, {
      since: '2026-07-26T00:58:00.000Z',
    });
  });

  it('advances through scanned non-matches without moving a cursor backwards', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, {
      cursor: { timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'current' },
    });
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      owner: 'acme',
      repo: 'demo',
      store,
      poller: {
        poll: async () => ({
          candidates: [],
          truncated: false,
          pages: 1,
          cursor: { timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'scanned' },
        }),
      } as never,
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(store.state(definition.id)?.cursor).toEqual({
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: 'scanned',
    });
  });
});

describe('WorkspaceAutomationScheduler', () => {
  it('arms its first timer when a definition is enabled after startup', async () => {
    const { store, definition } = await setup();
    store.update(definition.id, definition.revision, { ...definition, enabled: false });
    const coordinator = {
      refresh: vi.fn(async () => undefined),
      enabledProjectIds: () => store.list().some((item) => item.enabled) ? ['p'] : [],
      store: () => store,
    };
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: coordinator as never,
      handle: () => ({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }),
    });
    await scheduler.start();
    expect(scheduler.hasTimer()).toBe(false);
    const paused = store.get(definition.id)!;
    store.update(paused.id, paused.revision, { ...paused, enabled: true });
    await scheduler.reschedule();
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.stop();
  });

  it('keeps one timer when overlapping reschedules resolve out of order', async () => {
    vi.useFakeTimers();
    try {
      const { store } = await setup();
      const releases: Array<() => void> = [];
      const coordinator = {
        refresh: () => new Promise<void>((resolve) => releases.push(resolve)),
        enabledProjectIds: () => ['p'],
        store: () => store,
      };
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: coordinator as never,
        handle: () => ({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }),
      });
      const started = scheduler.start();
      releases.shift()!();
      await started;
      const first = scheduler.reschedule();
      const second = scheduler.reschedule();
      releases.pop()!();
      await second;
      releases.shift()!();
      await first;
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

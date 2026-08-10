import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTaskStore } from './store.ts';
import {
  ProjectScheduledScheduler,
  WorkspaceScheduledScheduler,
  dueInstant,
  type ProjectScheduledHandle,
} from './scheduler.ts';
import type { ScheduledTaskDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function setup(overrides: Partial<ScheduledTaskDefinition> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-sched-scheduler-'));
  dirs.push(dir);
  const store = ScheduledTaskStore.open(dir);
  const definition = store.create({
    name: 'Nightly',
    enabled: true,
    timing: { kind: 'once', at: '2020-01-01T00:00:00.000Z', timezone: 'UTC' },
    task: { prompt: 'go' },
    ...overrides,
  } as never, 'one');
  return { store, definition };
}

function handle(store: ScheduledTaskStore, launch = vi.fn(async () => ({ runId: 'run-1' }))): ProjectScheduledHandle {
  return { projectId: 'p', store, launch, onChange: vi.fn() };
}

describe('ProjectScheduledScheduler', () => {
  it('reserves once, launches once, and completes the definition', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run-1' }));
    const scheduler = new ProjectScheduledScheduler(handle(store, launch));
    expect(await scheduler.fire(definition)).toBe('launched');
    expect(await scheduler.fire(definition)).toBe('skipped');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.state('one')?.status).toBe('completed');
    expect(store.occurrencesList({ scheduledTaskId: 'one' })[0]).toMatchObject({ status: 'launched', runId: 'run-1' });
  });

  it('records a config error without relaunching, keeping the key consumed', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => { throw new Error('unknown workflow: quick-task'); });
    const scheduler = new ProjectScheduledScheduler(handle(store, launch));
    expect(await scheduler.fire(definition)).toBe('config-error');
    expect(await scheduler.fire(definition)).toBe('skipped');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.state('one')?.status).toBe('error');
    expect(store.occurrencesList({ scheduledTaskId: 'one' })[0]).toMatchObject({ status: 'config-error' });
  });

  it('Run now reserves a manual occurrence, launches, and consumes the definition', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async (_d: unknown, _o: string, _t: 'scheduled' | 'manual', _s: string) => ({ runId: 'run-manual' }));
    const scheduler = new ProjectScheduledScheduler(handle(store, launch as never));
    const result = await scheduler.runNow(definition);
    expect(result.runId).toBe('run-manual');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![2]).toBe('manual');
    expect(store.get('one')?.enabled).toBe(false);
    expect(store.state('one')?.status).toBe('completed');
    // A consumed definition is no longer a timer candidate.
    expect(dueInstant(store, store.get('one')!)).toBeNull();
  });
});

describe('WorkspaceScheduledScheduler', () => {
  function coordinator(store: ScheduledTaskStore) {
    return {
      refresh: vi.fn(async () => undefined),
      enabledProjectIds: () => (store.list().some((d) => d.enabled) ? ['p'] : []),
      store: () => store,
    };
  }

  it('does not arm a timer when nothing is enabled', async () => {
    const { store, definition } = await setup();
    store.update(definition.id, definition.revision, {
      name: definition.name, enabled: false, timing: definition.timing, task: definition.task,
    });
    const launch = vi.fn(async () => ({ runId: 'x' }));
    const scheduler = new WorkspaceScheduledScheduler({
      coordinator: coordinator(store) as never,
      handle: () => handle(store, launch),
    });
    await scheduler.start();
    expect(scheduler.hasTimer()).toBe(false);
    scheduler.stop();
  });

  it('fires an overdue definition once as soon as it is armed', async () => {
    vi.useFakeTimers();
    try {
      const { store } = await setup(); // at is in the year 2020, well overdue
      const launch = vi.fn(async () => ({ runId: 'run-1' }));
      const scheduler = new WorkspaceScheduledScheduler({
        coordinator: coordinator(store) as never,
        handle: () => handle(store, launch),
        now: () => Date.now(),
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(5);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(store.state('one')?.status).toBe('completed');
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms a bounded segment for a due instant past the timer horizon without firing', async () => {
    vi.useFakeTimers();
    try {
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(base);
      const farFuture = new Date(base + 2 ** 31 + 60_000).toISOString();
      const { store } = await setup({ timing: { kind: 'once', at: farFuture, timezone: 'UTC' } });
      const launch = vi.fn(async () => ({ runId: 'x' }));
      const scheduler = new WorkspaceScheduledScheduler({
        coordinator: coordinator(store) as never,
        handle: () => handle(store, launch),
        now: () => Date.now(),
      });
      await scheduler.start();
      expect(scheduler.hasTimer()).toBe(true);
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      // The horizon wake re-armed rather than firing.
      expect(launch).not.toHaveBeenCalled();
      expect(scheduler.hasTimer()).toBe(true);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

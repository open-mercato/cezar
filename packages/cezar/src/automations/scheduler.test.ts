import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from './store.ts';
import { ProjectAutomationScheduler, WorkspaceAutomationScheduler } from './scheduler.ts';
import type { GithubAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-scheduler-')); dirs.push(dir);
  const store = AutomationStore.open(dir);
  const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'one') as GithubAutomationDefinition;
  return { store, definition };
}
const candidate = { eventId: 'event', event: 'issue.opened' as const, timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'Issue', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] };
const reviewCandidate = {
  ...candidate,
  repo: 'acme/demo',
  nodeId: 'PR_one',
  number: 8,
  title: 'Review me',
  url: 'https://github.com/acme/demo/pull/8',
  author: 'alice',
  assignees: [],
  labels: [],
};

describe('ProjectAutomationScheduler', () => {
  it('previews without cursor, receipt, or launch mutation', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
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
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
    await scheduler.check(definition);
    await scheduler.check(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.latestReceipts().get('one:event')).toMatchObject({ status: 'launched', runId: 'run' });
  });

  it('deduplicates review-request bursts that straddle two polls', async () => {
    const { store, definition } = await setup();
    const reviewDefinition = {
      ...definition,
      events: ['pull_request.review_requested', 'pull_request.rereview_requested'],
    } satisfies GithubAutomationDefinition;
    const first = {
      ...reviewCandidate,
      eventId: 'acme/demo:PR_one:pull_request.rereview_requested:RRE_one',
      event: 'pull_request.rereview_requested' as const,
      timestamp: '2026-07-26T02:00:21.000Z',
      tieBreaker: 'RRE_one:rereview',
      reviewer: 'patzick',
    };
    const second = {
      ...reviewCandidate,
      eventId: 'acme/demo:PR_one:pull_request.review_requested:RRE_two',
      event: 'pull_request.review_requested' as const,
      timestamp: '2026-07-26T02:00:35.000Z',
      tieBreaker: 'RRE_two',
      reviewer: 'mkucmus',
    };
    const polls = [first, second];
    const launch = vi.fn(async () => ({ runId: `run-${launch.mock.calls.length + 1}` }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: {
        owner: 'acme',
        repo: 'demo',
        poller: {
          poll: async () => {
            const next = polls.shift()!;
            return {
              candidates: [next],
              cursor: { timestamp: next.timestamp, tieBreaker: next.tieBreaker },
              truncated: false,
              pages: 1,
            };
          },
        } as never,
      },
      launch,
    });
    await scheduler.check(reviewDefinition);
    await scheduler.check(reviewDefinition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect([...store.latestReceipts().values()]).toHaveLength(1);
    expect(store.logs({ automationId: definition.id, result: 'duplicate' })[0]).toMatchObject({
      event: 'pull_request.review_requested',
      githubNumber: 8,
      reason: 'A durable receipt already exists for this automation and pull request review-request burst.',
    });
  });

  it('allows a later review request on the same PR after the poll interval window', async () => {
    const { store, definition } = await setup();
    const reviewDefinition = {
      ...definition,
      events: ['pull_request.review_requested'],
    } satisfies GithubAutomationDefinition;
    const first = {
      ...reviewCandidate,
      eventId: 'acme/demo:PR_one:pull_request.review_requested:RRE_one',
      event: 'pull_request.review_requested' as const,
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: 'RRE_one',
      reviewer: 'patzick',
    };
    const second = {
      ...reviewCandidate,
      eventId: 'acme/demo:PR_one:pull_request.review_requested:RRE_two',
      event: 'pull_request.review_requested' as const,
      timestamp: '2026-07-26T02:06:00.000Z',
      tieBreaker: 'RRE_two',
      reviewer: 'mkucmus',
    };
    const polls = [first, second];
    const launch = vi.fn(async () => ({ runId: `run-${launch.mock.calls.length + 1}` }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: {
        owner: 'acme',
        repo: 'demo',
        poller: {
          poll: async () => {
            const next = polls.shift()!;
            return {
              candidates: [next],
              cursor: { timestamp: next.timestamp, tieBreaker: next.tieBreaker },
              truncated: false,
              pages: 1,
            };
          },
        } as never,
      },
      launch,
    });
    await scheduler.check(reviewDefinition);
    await scheduler.check(reviewDefinition);
    expect(launch).toHaveBeenCalledTimes(2);
    expect([...store.latestReceipts().values()]).toHaveLength(2);
  });

  it('does not advance the cursor on failure and applies bounded backoff', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({ ...current, cursor: { timestamp: '2026-07-26T01:00:00.000Z' } }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: async () => { throw new Error('rate limited'); } } as never }, launch: async () => ({ runId: 'unused' }) });
    await expect(scheduler.check(definition)).rejects.toThrow('rate limited');
    expect(store.state(definition.id)?.cursor?.timestamp).toBe('2026-07-26T01:00:00.000Z');
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 1, backoffUntil: expect.any(String) });
  });

  it('logs the poll it skipped when another process holds the lease, and re-arms one interval out (#983)', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    expect(held).toBeDefined();
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) });
    const before = Date.now();
    await expect(scheduler.check(definition)).rejects.toThrow('lease is held by another process');
    expect(poll).not.toHaveBeenCalled();
    // The poll that did not happen is on the record, instead of ten silent minutes.
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({
      result: 'skipped',
      reason: 'automation polling lease is held by another process',
    });
    const state = store.state(definition.id)!;
    expect(Date.parse(state.nextCheckAt!)).toBeGreaterThanOrEqual(before + definition.intervalSeconds * 1_000);
    // A busy lease is not the automation being broken: no failure counter, no exponential backoff.
    expect(state.consecutiveFailures).toBeUndefined();
    expect(state.backoffUntil).toBeUndefined();
    held?.release();
  });

  it('logs a contended lease in preview mode without writing state', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
    await expect(scheduler.check(definition, 'preview')).rejects.toThrow('lease is held by another process');
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped' });
    expect(store.state(definition.id)).toBeUndefined();
    held?.release();
  });

  it('starts provider discovery from the durable cursor overlap', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z' },
    }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never },
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(poll).toHaveBeenCalledWith('acme', 'demo', definition, {
      since: '2026-07-26T00:58:00.000Z',
    });
  });

  it('advances through scanned non-matches without moving a cursor backwards', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'current' },
    }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: {
        owner: 'acme',
        repo: 'demo',
        poller: {
          poll: async () => ({
            candidates: [],
            truncated: false,
            pages: 1,
            cursor: { timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'scanned' },
          }),
        } as never,
      },
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(store.state(definition.id)?.cursor).toEqual({
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: 'scanned',
    });
  });
});

/**
 * #982: once the 120-second overlap band alone holds `maxRecords` events, every poll spends its
 * whole budget re-reading them, hands back the cursor it was given, and the next interval asks the
 * identical question. These tests pin the escape and its cost.
 */
describe('ProjectAutomationScheduler — a saturated overlap band (#982)', () => {
  /** An ordered run of observations, drained exactly the way `GithubPoller.poll()` drains one. */
  function fakePoller(run: Array<{ timestamp: string; tieBreaker: string }>) {
    const poll = vi.fn(async (
      _owner: string,
      _repo: string,
      _definition: unknown,
      options: { since?: string; maxRecords?: number } = {},
    ) => {
      const budget = options.maxRecords ?? 25;
      const window = run.filter((entry) => !options.since || entry.timestamp >= options.since);
      const evaluated = window.slice(0, budget);
      return {
        candidates: [],
        truncated: window.length > budget,
        pages: 1,
        cursor: evaluated.at(-1),
      };
    });
    return { poll };
  }

  /** `count` label events written into the same second — the reporter's grooming automation. */
  const band = (count: number, timestamp = '2026-09-10T15:12:30.000Z') =>
    Array.from({ length: count }, (_, index) => ({ timestamp, tieBreaker: `band-${String(index).padStart(3, '0')}` }));

  /** An automation parked on `cursor` — by default the run's last record, so a short prefix of
   *  the band can never reach past it. */
  async function pinnedAt(
    run: Array<{ timestamp: string; tieBreaker: string }>,
    cursor: { timestamp: string; tieBreaker: string } = run.at(-1)!,
  ) {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({ ...current, cursor }));
    const poller = fakePoller(run);
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: { owner: 'acme', repo: 'demo', poller: poller as never },
      launch: async () => ({ runId: 'unused' }),
    });
    return { store, definition, scheduler, poller, cursor };
  }

  it('climbs out of the band the old code was pinned in, doubling up to the 100-record ceiling', async () => {
    const beyond = { timestamp: '2026-09-11T09:31:09.000Z', tieBreaker: 'beyond' };
    // 30 label events in one second plus an hours-later record the 25-record budget never reaches.
    const { store, definition, scheduler, poller } = await pinnedAt([...band(30), beyond], band(30).at(-1)!);

    await scheduler.check(definition);

    expect(poller.poll.mock.calls.map((call) => (call[3] as { maxRecords?: number }).maxRecords))
      .toEqual([undefined, 50]);
    expect(store.state(definition.id)?.cursor).toEqual(beyond);
    expect(store.state(definition.id)?.pinnedCursor).toBeUndefined();
    expect(store.logs({ automationId: definition.id })[0]?.reason)
      .toBe('The overlap band was saturated; a 50-record re-poll moved the cursor past it.');
  });

  it('pays the climb once per pinned cursor when the band is still saturated at 100', async () => {
    const { store, definition, scheduler, poller } = await pinnedAt(band(150));

    await scheduler.check(definition);
    expect(poller.poll.mock.calls.map((call) => (call[3] as { maxRecords?: number }).maxRecords))
      .toEqual([undefined, 50, 100]);
    const pinnedCursor = store.state(definition.id)?.pinnedCursor;
    expect(pinnedCursor).toEqual(band(150).at(-1));
    // The marker has to survive the state file's own schema, not just the in-memory copy.
    expect(AutomationStore.open(store.dataDir).state(definition.id)?.pinnedCursor).toEqual(pinnedCursor);

    poller.poll.mockClear();
    await scheduler.check(definition);
    // Still pinned at the search API's own ceiling: one poll, no ladder.
    expect(poller.poll).toHaveBeenCalledTimes(1);
    expect(store.state(definition.id)?.pinnedCursor).toEqual(pinnedCursor);
    expect(store.logs({ automationId: definition.id })[0]?.reason)
      .toContain('holds 100 or more records, so the cursor cannot advance past it');
  });

  it('clears the marker and climbs again once the cursor finally moves', async () => {
    const { store, definition, scheduler, poller } = await pinnedAt(band(150));
    await scheduler.check(definition);
    expect(store.state(definition.id)?.pinnedCursor).toBeDefined();

    const freed = { timestamp: '2026-09-11T09:31:09.000Z', tieBreaker: 'freed' };
    poller.poll.mockResolvedValue({ candidates: [], truncated: false, pages: 1, cursor: freed });
    poller.poll.mockClear();
    await scheduler.check(definition);

    expect(store.state(definition.id)?.cursor).toEqual(freed);
    expect(store.state(definition.id)?.pinnedCursor).toBeUndefined();
  });

  it('climbs again after the operator narrows the filter the pinned log told them to narrow', async () => {
    const { store, definition, scheduler } = await pinnedAt(band(150));
    await scheduler.check(definition);
    expect(store.state(definition.id)?.pinnedCursor).toEqual(band(150).at(-1));

    // The remediation the `no-match` row prescribes: narrow the filter so the band stops saturating.
    // 40 records still overrun the 25-record budget, so escaping it needs the ladder — which the
    // marker would skip if an edit did not clear it.
    const narrowed = store.update(definition.id, definition.revision, {
      ...definition,
      filters: { ...definition.filters, allLabels: ['grooming'] },
    }) as GithubAutomationDefinition;
    expect(store.state(definition.id)?.pinnedCursor).toBeUndefined();

    const beyond = { timestamp: '2026-09-11T09:31:09.000Z', tieBreaker: 'beyond' };
    const poller = fakePoller([...band(40), beyond]);
    const narrowedScheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: { owner: 'acme', repo: 'demo', poller: poller as never },
      launch: async () => ({ runId: 'unused' }),
    });

    await narrowedScheduler.check(narrowed);

    expect(poller.poll.mock.calls.map((call) => (call[3] as { maxRecords?: number }).maxRecords))
      .toEqual([undefined, 50]);
    expect(store.state(definition.id)?.cursor).toEqual(beyond);
    expect(store.state(definition.id)?.pinnedCursor).toBeUndefined();
  });

  it('leaves an ordinary no-new-events poll alone — one call, no marker', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'current' },
    }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1, cursor: undefined }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never },
      launch: async () => ({ runId: 'unused' }),
    });

    await scheduler.check(definition);

    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith('acme', 'demo', definition, { since: '2026-07-26T00:58:00.000Z' });
    expect(store.state(definition.id)?.pinnedCursor).toBeUndefined();
    expect(store.state(definition.id)?.cursor).toEqual({ timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'current' });
    expect(store.logs({ automationId: definition.id })[0]?.reason).toBe('Scheduled check completed.');
  });

  it('does not climb in preview mode — the cursor it would climb for is never stored', async () => {
    const { store, definition, poller } = await pinnedAt(band(150));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      timeZone: 'UTC',
      store,
      github: { owner: 'acme', repo: 'demo', poller: poller as never },
      launch: async () => ({ runId: 'unused' }),
    });

    await scheduler.check(definition, 'preview');

    expect(poller.poll).toHaveBeenCalledTimes(1);
    expect(store.state(definition.id)?.pinnedCursor).toBeUndefined();
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
      handle: () => ({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never } }),
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
        handle: () => ({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never } }),
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

describe('WorkspaceAutomationScheduler — both kinds (spec 2026-09-14)', () => {
  const T0 = Date.parse('2026-09-14T03:59:00Z');

  async function workspace(withGithub: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-scheduler-kinds-')); dirs.push(dir);
    const store = AutomationStore.open(dir);
    store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump' } }, 'nightly');
    store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'issues');
    store.setState('issues', (current) => ({ ...current, nextCheckAt: new Date(T0 + 30 * 60_000).toISOString() }));
    const launchSchedule = vi.fn(async () => ({ runId: 'sched-run' }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    let now = T0;
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({
        projectId: 'p', timeZone: 'UTC', store, launchSchedule,
        ...(withGithub ? { github: { owner: 'acme', repo: 'demo', poller: { poll } as never } } : {}),
      }),
      now: () => now,
    });
    return { store, scheduler, launchSchedule, poll, tick: (ms: number) => { now = ms; } };
  }

  it('arms one timer for the earlier of a poll and a schedule, and fires the schedule', async () => {
    vi.useFakeTimers();
    try {
      const { store, scheduler, launchSchedule, poll } = await workspace(true);
      vi.setSystemTime(T0);
      await scheduler.start();
      expect(scheduler.hasTimer()).toBe(true);
      // The schedule persisted its next occurrence (04:00) on first sight; the poll is due at 04:29.
      expect(store.state('nightly')?.nextRunAt).toBe('2026-09-14T04:00:00.000Z');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      expect(poll).not.toHaveBeenCalled();
      expect(store.latestReceipts().get('nightly:schedule:2026-09-14T04:00:00.000Z')).toMatchObject({ status: 'launched', runId: 'sched-run' });
      // Re-armed for tomorrow, not for right now.
      expect(store.state('nightly')?.nextRunAt).toBe('2026-09-15T04:00:00.000Z');
      expect(scheduler.hasTimer()).toBe(true);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the poll kind for a project without a GitHub remote but still fires its schedule', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, launchSchedule, poll } = await workspace(false);
      vi.setSystemTime(T0);
      await scheduler.start();
      expect(scheduler.hasTimer()).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      expect(poll).not.toHaveBeenCalled();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkspaceAutomationScheduler — a rejected check never re-arms at zero delay (#983)', () => {
  const T0 = Date.parse('2026-09-14T06:00:00Z');

  /**
   * `persist: false` models a cockpit that cannot write its automation state — a read-only home
   * degrades rather than crashing (AGENTS.md). Nothing then moves `nextCheckAt` forward, so the
   * workspace scheduler's own retry floor is the only thing standing between a rejected check and
   * a `Math.max(0, past - now) === 0` spin.
   */
  async function project(id: string, dueAt: number, options: { persist?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), `cezar-scheduler-retry-${id}-`)); dirs.push(dir);
    const store = AutomationStore.open(dir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, `${id}-issues`) as GithubAutomationDefinition;
    store.setState(definition.id, (current) => ({ ...current, nextCheckAt: new Date(dueAt).toISOString() }));
    if (options.persist === false) store.setState = () => { throw new Error('read-only automation state'); };
    return { store, definition };
  }

  it('pushes a rejected check out by its interval instead of spinning, then tries it again', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const poll = vi.fn(async () => { throw new Error('rate limited'); });
      const { store } = await project('a', T0 - 60_000, { persist: false });
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['a'], store: () => store } as never,
        handle: () => ({ projectId: 'a', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) }),
        now: () => T0,
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(1);
      // Before the fix this re-armed at 0ms and burned CPU until the lock aged out.
      await vi.advanceTimersByTimeAsync(299_000);
      expect(poll).toHaveBeenCalledTimes(1);
      // A backoff, not a mute: once the interval has passed the check runs again.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(poll).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the workspace slot to another project while the failing one waits out its floor', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const failing = vi.fn(async () => { throw new Error('rate limited'); });
      const healthy = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const stores: Record<string, AutomationStore> = {
        a: (await project('a', T0 - 60_000, { persist: false })).store,
        b: (await project('b', T0 + 30_000)).store,
      };
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['a', 'b'], store: (id: string) => stores[id] } as never,
        handle: (projectId, store) => ({ projectId, timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller: { poll: projectId === 'a' ? failing : healthy } as never }, launch: async () => ({ runId: 'unused' }) }),
        now: () => T0,
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(failing).toHaveBeenCalledTimes(1);
      // Before the fix project 'a' owned the workspace's only slot and 'b' never got a turn.
      expect(healthy).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

it('backs off a contended composer start so another project can launch, without consuming it', async () => {
  vi.useFakeTimers();
  const now = Date.parse('2026-10-13T09:00:00Z');
  vi.setSystemTime(now);
  const first = await setup(), second = await setup();
  first.store.delete(first.definition.id); second.store.delete(second.definition.id);
  const make = (store: AutomationStore, offset: number) => store.create({ name: 'Deferred', kind: 'schedule', enabled: true,
    schedule: { type: 'once', date: '2026-10-13', hour: 8, minute: 0 }, task: { prompt: 'test' },
    deferredStart: { origin: 'composer', reason: 'at', notBefore: new Date(now - 2000 + offset).toISOString(), timeZone: 'UTC',
      binding: { runner: 'claude', revision: 'r', accounts: [] }, creationKey: 'key', requestDigest: 'digest', status: 'pending', runIds: [] } });
  const a = make(first.store, 0), b = make(second.store, 1);
  const lease = first.store.acquireLease()!;
  const attempts = vi.spyOn(first.store, 'acquireLease');
  const launch = vi.fn(async () => ({ runId: 'run' }));
  const scheduler = new WorkspaceAutomationScheduler({ coordinator: { refresh: async () => {}, enabledProjectIds: () => ['a', 'b'], store: (id: string) => id === 'a' ? first.store : second.store } as unknown as import('./coordinator.ts').AutomationCoordinator,
    handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', validateDeferred: async () => {}, launchSchedule: launch }) });
  try {
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(second.store.get(b.id)).toBeUndefined();
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(first.store.get(a.id)?.deferredStart?.notBefore).toBe(a.deferredStart?.notBefore);
    lease.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toHaveBeenCalledTimes(2);
  } finally { scheduler.stop(); lease.release(); vi.useRealTimers(); }
});

it('retains a recurring occurrence on contention and retries without starving another project', async () => {
  vi.useFakeTimers();
  const now = Date.parse('2026-10-13T09:00:00Z');
  vi.setSystemTime(now);
  const first = await setup(), second = await setup();
  first.store.delete(first.definition.id); second.store.delete(second.definition.id);
  const make = (store: AutomationStore, offset: number) => {
    const definition = store.create({ name: 'Daily', kind: 'schedule', enabled: true,
      schedule: { type: 'daily', hour: 9, minute: 0 }, task: { prompt: 'test' } });
    store.setState(definition.id, s => ({ ...s, nextRunAt: new Date(now - 2000 + offset).toISOString() }));
    return definition;
  };
  const a = make(first.store, 0); make(second.store, 1);
  const lease = first.store.acquireLease()!;
  const attempts = vi.spyOn(first.store, 'acquireLease');
  const launch = vi.fn(async () => ({ runId: 'run' }));
  const scheduler = new WorkspaceAutomationScheduler({
    coordinator: { refresh: async () => {}, enabledProjectIds: () => ['a', 'b'], store: (id: string) => id === 'a' ? first.store : second.store } as unknown as import('./coordinator.ts').AutomationCoordinator,
    handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule: launch }),
  });
  try {
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(first.store.state(a.id)?.nextRunAt).toBe(new Date(now - 2000).toISOString());
    lease.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(Date.parse(first.store.state(a.id)!.nextRunAt!)).toBeGreaterThan(now);
  } finally { scheduler.stop(); lease.release(); vi.useRealTimers(); }
});

describe('WorkspaceAutomationScheduler — long waits (#1340)', () => {
  const MAX_WAIT = 2_147_483_647;
  const T0 = Date.parse('2026-10-14T12:00:00Z');

  async function futureSchedule(days: number, deferred = true) {
    const { store, definition } = await setup();
    store.delete(definition.id);
    const due = T0 + days * 86_400_000;
    const at = new Date(due).toISOString();
    const scheduled = store.create({
      name: 'Future task', kind: 'schedule', enabled: true,
      schedule: { type: 'once', date: at.slice(0, 10), hour: 12, minute: 0 },
      task: { prompt: 'test' },
      ...(deferred ? { deferredStart: {
        origin: 'composer' as const, reason: 'at' as const, notBefore: at, timeZone: 'UTC',
        binding: { runner: 'claude' as const, revision: 'r', accounts: [] },
        creationKey: 'key', requestDigest: 'digest', status: 'pending' as const, runIds: [],
      } } : {}),
    });
    const launch = vi.fn(async () => ({ runId: 'future-run' }));
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: async () => {}, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', validateDeferred: async () => {}, launchSchedule: launch }),
    });
    return { store, scheduled, due, launch, scheduler };
  }

  it.each([
    { days: 30, deferred: true },
    { days: 60, deferred: true },
    { days: 30, deferred: false },
  ])('bounds a $days-day wait (deferred=$deferred) and launches exactly once at the due instant', async ({ days, deferred }) => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { scheduler, launch, store, due } = await futureSchedule(days, deferred);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const lease = vi.spyOn(store, 'acquireLease');
    try {
      await scheduler.start();
      // Fails immediately on the old implementation, before advancing an overflowing timer.
      expect(timer).toHaveBeenLastCalledWith(expect.any(Function), MAX_WAIT);
      for (let remaining = due - T0; remaining > MAX_WAIT; remaining -= MAX_WAIT) {
        await vi.advanceTimersByTimeAsync(MAX_WAIT);
        expect(launch).not.toHaveBeenCalled();
        expect(lease).not.toHaveBeenCalled();
        expect(store.receipts()).toEqual([]);
        expect(vi.getTimerCount()).toBe(1);
        expect(timer).toHaveBeenLastCalledWith(expect.any(Function), Math.min(MAX_WAIT, remaining - MAX_WAIT));
      }
      await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
      expect(launch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(store.receipts().filter(receipt => receipt.status === 'launched')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(scheduler.hasTimer()).toBe(false);
    } finally {
      scheduler.stop();
      timer.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels intermediate waits on stop and replaces them on reschedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { scheduler, store, scheduled, launch } = await futureSchedule(60);
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(MAX_WAIT);
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(MAX_WAIT);
      expect(launch).not.toHaveBeenCalled();
      await scheduler.start();
      expect(vi.getTimerCount()).toBe(1);
      // A newly due item must replace the long wait, with no stale timer left behind.
      store.delete(scheduled.id);
      store.create({
        name: 'Soon', kind: 'schedule', enabled: true,
        schedule: { type: 'once', date: '2026-12-01', hour: 12, minute: 0 },
        task: { prompt: 'test' },
      }, 'soon');
      store.setState('soon', state => ({ ...state, nextRunAt: new Date(Date.now() + 60_000).toISOString() }));
      await scheduler.reschedule();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(launch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});

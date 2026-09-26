import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationStore } from './store.ts';
import { runEventPollCycle } from './event-poll-cycle.ts';

describe('shared event cycle', () => {
  it('does not launch or overwrite state after a cross-process pause during polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-cycle-'));
    const store = AutomationStore.open(dir);
    const definition = store.create({ kind: 'github', enabled: true, name: 'test', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test' } });
    let resolve!: (value: { candidates: { eventId: string; timestamp: string }[] }) => void;
    const launch = vi.fn();
    const pending = runEventPollCycle({ store, definition, mode: 'execute', poll: () => new Promise(r => { resolve = r; }), launch, persist: vi.fn() });
    const other = AutomationStore.open(dir);
    const paused = other.update(definition.id, definition.revision, { ...definition, enabled: false });
    resolve({ candidates: [{ eventId: 'event', timestamp: new Date().toISOString() }] });
    await pending;
    expect(launch).not.toHaveBeenCalled();
    expect(store.get(definition.id)?.revision).toBe(paused.revision);
  });
});

it('holds the mutation lease throughout an asynchronous launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-cycle-'));
  const store = AutomationStore.open(dir);
  const definition = store.create({ kind: 'github', enabled: true, name: 'test', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test' } });
  const other = AutomationStore.open(dir);
  await runEventPollCycle({ store, definition, mode: 'execute', poll: async () => ({ candidates: [{ timestamp: new Date().toISOString() }] }),
    launch: async () => {
      await Promise.resolve();
      expect(() => other.update(definition.id, definition.revision, { ...definition, enabled: false })).toThrow('mutation conflict');
    }, persist: (_result, current) => ({ ...current, checkpoint: 'completed' }),
  });
  expect(store.state(definition.id)?.checkpoint).toBe('completed');
});

it('preview never advances a checkpoint or launches and excludes pre-baseline events', async () => {
  const store = AutomationStore.open(mkdtempSync(join(tmpdir(), 'event-cycle-')));
  const definition = store.create({ kind: 'github', enabled: true, name: 'test', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test' } });
  store.setState(definition.id, () => ({ baselineAt: '2026-09-19T01:00:00.000Z', checkpoint: 'before' }));
  const launch = vi.fn();
  const persist = vi.fn();
  const result = await runEventPollCycle({ store, definition, mode: 'preview', poll: async () => ({ candidates: [{ timestamp: '2026-09-19T00:00:00.000Z' }, { timestamp: '2026-09-19T02:00:00.000Z' }] }), launch, persist });
  expect(result.candidates).toHaveLength(1);
  expect(launch).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  expect(store.state(definition.id)?.checkpoint).toBe('before');
});

it('tracker uses durable receipts across repeated history and does not fabricate changes', async () => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const store = AutomationStore.open(mkdtempSync(join(tmpdir(), 'event-cycle-')));
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: true, name: 'test', intervalSeconds: 1800, filters: { lookbackDays: 7, maxRecords: 25 }, trackerTrigger: { association, events: ['issue.status_changed'], targetStatusIds: ['todo'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  store.setState(definition.id, () => ({ baselineAt: '2026-09-19T00:00:00.000Z' }));
  const candidate = { eventId: 'history:1', event: 'issue.status_changed' as const, timestamp: '2026-09-19T01:00:00.000Z', tieBreaker: '1', association, provider: 'jira' as const, issueId: '123', key: 'P-1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', labels: [], status: 'todo', change: { toId: 'todo' } };
  let candidates = [candidate];
  const pollEvents = vi.fn(async () => ({ candidates, checkpoint: 'scan-complete', complete: true }));
  const launchTracker = vi.fn(async () => ({ runId: 'run' }));
  const scheduler = new ProjectTrackerAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, launchTracker,
    tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents }) },
  });
  await scheduler.check(definition, 'preview');
  expect(store.receipts()).toHaveLength(0);
  expect(store.state(definition.id)?.checkpoint).toBeUndefined();
  await scheduler.check(definition);
  await scheduler.check(definition);
  expect(launchTracker).toHaveBeenCalledTimes(1);
  candidates = [{ ...candidate, eventId: 'history:3', timestamp: '2026-09-19T02:00:00.000Z' }];
  await scheduler.check(definition);
  expect(launchTracker).toHaveBeenCalledTimes(2);
  expect(store.state(definition.id)?.checkpoint).toBe('scan-complete');
  expect(pollEvents).toHaveBeenLastCalledWith(expect.objectContaining({ checkpoint: 'scan-complete' }));
});

it('retry reservation persists before launch and rejects a stale retry after another process reserves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-cycle-'));
  const store = AutomationStore.open(dir);
  const receipt = store.reserveReceipt({ automationId: 'test', revision: 1, eventId: 'event' })!;
  store.appendReceipt({ ...receipt, status: 'launch-error' });
  const staleProcess = AutomationStore.open(dir);
  const reserved = store.reserveRetry(receipt.receiptId);
  expect(reserved?.status).toBe('reserved');
  expect(AutomationStore.open(dir).latestReceipts().get(receipt.receiptKey)?.status).toBe('reserved');
  expect(staleProcess.reserveRetry(receipt.receiptId)).toBeUndefined();
});

it('reads another process new baseline before polling the current revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-cycle-'));
  const store = AutomationStore.open(dir);
  const definition = store.create({ kind: 'github', enabled: true, name: 'test', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test' } });
  store.setState(definition.id, () => ({ baselineAt: '2026-09-19T00:00:00.000Z' }));
  const other = AutomationStore.open(dir);
  const updated = other.update(definition.id, definition.revision, definition);
  other.setState(definition.id, current => ({ ...current, baselineAt: '2026-09-19T02:00:00.000Z' }));
  const launch = vi.fn();
  const poll = vi.fn(async () => ({ candidates: [{ timestamp: '2026-09-19T01:00:00.000Z' }] }));
  await runEventPollCycle({ store, definition: updated, mode: 'execute', poll, launch, persist: (_result, state) => state });
  expect(poll).toHaveBeenCalledWith(expect.objectContaining({ baselineAt: '2026-09-19T02:00:00.000Z' }));
  expect(launch).not.toHaveBeenCalled();
});

it.each([true, false])('rejects a poll captured between definition publication and a delayed baseline write (candidate: %s)', async hasCandidate => {
  const dir = mkdtempSync(join(tmpdir(), 'event-cycle-'));
  const writer = AutomationStore.open(dir);
  const reader = AutomationStore.open(dir);
  const definition = writer.create({ kind: 'github', enabled: false, name: 'test', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test' } });
  writer.setState(definition.id, () => ({ baselineAt: '2026-09-19T00:00:00.000Z', checkpoint: 'old' }));
  const enabled = writer.update(definition.id, definition.revision, { ...definition, enabled: true });
  let finish!: (value: { candidates: { timestamp: string }[] }) => void;
  const launch = vi.fn();
  const pending = runEventPollCycle({ store: reader, definition: enabled, mode: 'execute',
    poll: () => new Promise<{ candidates: { timestamp: string }[] }>(resolve => { finish = resolve; }), launch,
    persist: (_result, state) => ({ ...state, checkpoint: 'stale-poll-checkpoint' }),
  });
  writer.setState(definition.id, state => ({ ...state, baselineAt: '2026-09-19T02:00:00.000Z', checkpoint: undefined }));
  finish({ candidates: hasCandidate ? [{ timestamp: '2026-09-19T01:00:00.000Z' }] : [] });
  await pending;
  expect(launch).not.toHaveBeenCalled();
  expect(writer.state(definition.id)).toMatchObject({ baselineAt: '2026-09-19T02:00:00.000Z' });
  expect(writer.state(definition.id)?.checkpoint).toBeUndefined();
});

it('publishes a definition and its new baseline inside the same mutation lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-cycle-'));
  const writer = AutomationStore.open(dir);
  const reader = AutomationStore.open(dir);
  const definition = writer.create({ kind: 'github', enabled: false, name: 'test', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test' } });
  const arm = vi.fn((updated: typeof definition) => {
    expect(reader.acquireMutationLease()).toBeUndefined();
    writer.setState(updated.id, () => ({ revision: updated.revision, baselineAt: '2026-09-19T02:00:00.000Z' }));
  });
  const enabled = writer.update(definition.id, definition.revision, { ...definition, enabled: true }, arm);
  expect(arm).toHaveBeenCalledTimes(1);
  expect(reader.get(definition.id)?.revision).toBe(enabled.revision);
  expect(reader.state(definition.id)).toMatchObject({ revision: enabled.revision, baselineAt: '2026-09-19T02:00:00.000Z' });
});

it('previews a new paused tracker within lookback without making execute import old events', async () => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const store = AutomationStore.open(mkdtempSync(join(tmpdir(), 'event-cycle-')));
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: false, name: 'test', intervalSeconds: 1800, filters: { lookbackDays: 7, maxRecords: 25 }, trackerTrigger: { association, events: ['issue.opened'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  const timestamp = new Date(Date.now() - 86_400_000).toISOString();
  const candidate = { eventId: 'created:1', event: 'issue.opened' as const, timestamp, tieBreaker: '1', association, provider: 'jira' as const, issueId: '123', key: 'P-1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', labels: [], status: 'todo', change: {} };
  const pollEvents = vi.fn(async ({ baselineAt }: { baselineAt: string }) => ({ candidates: timestamp > baselineAt ? [candidate] : [], checkpoint: 'complete', complete: true }));
  const launchTracker = vi.fn(async () => ({ runId: 'run' }));
  const scheduler = new ProjectTrackerAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, launchTracker,
    tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents }) },
  });
  const result = await scheduler.check(definition, 'preview');
  expect(result.candidates).toEqual([candidate]);
  expect(Date.parse(pollEvents.mock.calls[0]![0].baselineAt)).toBeLessThan(Date.now() - 6 * 86_400_000);
  expect(store.state(definition.id)).toBeUndefined();
  expect(store.receipts()).toHaveLength(0);
  await scheduler.check(definition, 'execute');
  expect(launchTracker).not.toHaveBeenCalled();
  expect(Date.parse(pollEvents.mock.calls[1]![0].baselineAt)).toBeGreaterThan(Date.now() - 60_000);
});


it.each(['missing', 'corrupt', 'orphan-checkpoint'])('recovers %s tracker state with a durable baseline and launches only new events once', async damage => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const { createEventScanner } = await import('../server/tracker/event-scan.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tracker-recovery-'));
  const store = AutomationStore.open(dir);
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: true, name: 'test', intervalSeconds: 1800, filters: { lookbackDays: 7, maxRecords: 25 }, trackerTrigger: { association, events: ['issue.opened'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  if (damage === 'corrupt') writeFileSync(join(dir, 'automation-state.json'), '{broken');
  if (damage === 'orphan-checkpoint') store.setState(definition.id, () => ({ checkpoint: 'orphan' }));
  const opened = { id: '1', key: 'P-1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', createdAt: '2026-09-19T00:00:00.000Z', status: 'todo', labels: [] };
  let issues = [opened];
  const scanner = createEventScanner(association, async () => ({ issues }), async () => ({ events: [] }));
  const launchTracker = vi.fn(async () => ({ runId: 'run' }));
  const scheduler = new ProjectTrackerAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, launchTracker,
    tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents: scanner.poll }) },
  });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-09-19T01:00:00.000Z'));
    await scheduler.check(definition);
    const baseline = store.state(definition.id)?.baselineAt;
    expect(baseline).toBe('2026-09-19T01:00:00.000Z');
    expect(launchTracker).not.toHaveBeenCalled();
    issues = [...issues, { ...opened, id: '2', key: 'P-2', createdAt: '2026-09-19T01:00:01.000Z' }];
    vi.setSystemTime(new Date('2026-09-19T01:00:02.000Z'));
    await scheduler.check(definition);
    await scheduler.check(definition);
    expect(store.state(definition.id)?.baselineAt).toBe(baseline);
    expect(launchTracker).toHaveBeenCalledTimes(1);
    expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({ result: 'baseline', reason: expect.stringContaining('continuity gap') }));
  } finally { vi.useRealTimers(); }
});

it('persists queue progress and a visible history gap without duplicating surviving events', async () => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const { createEventScanner, candidate } = await import('../server/tracker/event-scan.ts');
  const { TrackerRequestError } = await import('../server/tracker/transport.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tracker-gap-'));
  const store = AutomationStore.open(dir);
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: true, name: 'test', intervalSeconds: 1800, filters: { lookbackDays: 7, maxRecords: 25 }, trackerTrigger: { association, events: ['issue.status_changed'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  store.setState(definition.id, () => ({ baselineAt: '2026-09-19T00:00:00.000Z' }));
  const issue = { id: '1', key: 'P-1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', createdAt: '2026-09-18T00:00:00.000Z', status: 'todo', labels: [] };
  let deleted = false;
  const scanner = createEventScanner(association, async () => ({ issues: [issue, { ...issue, id: '2', key: 'P-2' }] }), async current => {
    if (current.id === '1') {
      if (deleted) throw new TrackerRequestError('not_found', 'Gone');
      return { events: [], cursor: 'more' };
    }
    return { events: [candidate(association, current, 'issue.status_changed', 'h2', '2026-09-19T01:00:00.000Z', { toId: 'todo' })] };
  });
  const launchTracker = vi.fn(async () => ({ runId: 'run' }));
  const handle = { projectId: 'p', timeZone: 'UTC', store, launchTracker,
    tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents: scanner.poll }) },
  };
  await new ProjectTrackerAutomationScheduler(handle).check(definition);
  expect(JSON.parse(store.state(definition.id)!.checkpoint!).issues[0].id).toBe('1');
  deleted = true;
  const restarted = new ProjectTrackerAutomationScheduler({ ...handle, store: AutomationStore.open(dir) });
  await restarted.check(definition);
  await restarted.check(definition);
  expect(launchTracker).toHaveBeenCalledTimes(1);
  expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({ result: 'skipped', trackerKey: 'P-1', reason: expect.stringContaining('continuity gap') }));
});

it('persists slow Jira scan progress across restart and launches its eventual event exactly once', async () => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const { createJiraEventSource } = await import('../server/tracker/jira-events.ts');
  const { runOperation } = await import('../server/tracker/transport.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tracker-deadline-'));
  const store = AutomationStore.open(dir);
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: '1', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: true, name: 'test', intervalSeconds: 1800, filters: { lookbackDays: 7, maxRecords: 25 }, trackerTrigger: { association, events: ['issue.status_changed'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  const baselineAt = '2026-09-19T00:00:00.000Z';
  store.setState(definition.id, () => ({ baselineAt }));
  const source = createJiraEventSource(association, async (path, _init, signal) => {
    if (path === '/rest/api/3/myself') return { timeZone: 'UTC' };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1750);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    if (path.includes('/search/')) return { isLast: true, issues: [{ id: '1', key: 'P-1', fields: { project: { id: '1' }, summary: 'test', created: '2020-01-01T00:00:00Z', status: { name: 'To Do' }, labels: [] } }] };
    const start = Number(new URL(path, 'https://example.test').searchParams.get('startAt'));
    return { isLast: start === 6, startAt: start, maxResults: 1, values: [{ id: `h${start}`, created: start === 6 ? '2026-09-19T01:00:00Z' : '2020-01-01T00:00:00Z', items: [{ fieldId: 'status', from: 'done', to: 'todo' }] }] };
  });
  const launched: string[] = [];
  const handle = { projectId: 'p', timeZone: 'UTC', store,
    launchTracker: async (_definition: unknown, candidate: { eventId: string }) => { launched.push(candidate.eventId); return { runId: 'run' }; },
    tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents: (input: Parameters<typeof source.poll>[0]) => runOperation(signal => source.poll({ ...input, signal, now: '2026-09-19T01:01:00Z' })) }) },
  };
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-09-19T01:01:00Z'));
    const check = async (currentStore: AutomationStore) => {
      const pending = new ProjectTrackerAutomationScheduler({ ...handle, store: currentStore }).check(definition);
      await Promise.all([pending, vi.advanceTimersByTimeAsync(10_000)]);
    };
    await check(store);
    expect(JSON.parse(store.state(definition.id)!.checkpoint!)).toMatchObject({ watermark: baselineAt, historyCursor: '3' });
    expect(store.receipts()).toHaveLength(0);
    const restarted = AutomationStore.open(dir);
    await check(restarted);
    expect(launched).toHaveLength(1);
    expect(restarted.receipts()).toContainEqual(expect.objectContaining({ status: 'launched', runId: 'run' }));
    // The overlap window deliberately rediscovers the same history after completion.
    await check(restarted);
    await check(restarted);
    expect(launched).toHaveLength(1);
    expect(restarted.latestReceipts().size).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('persists required labels and only previews/launches matching creations', async () => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const dir = mkdtempSync(join(tmpdir(), 'label-cycle-'));
  const store = AutomationStore.open(dir);
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: true, name: 'bugs', intervalSeconds: 1800, trackerTrigger: { association, events: ['issue.opened'], requiredLabels: ['bug'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  expect(AutomationStore.open(dir).get(definition.id)?.trackerTrigger?.requiredLabels).toEqual(['bug']);
  store.setState(definition.id, () => ({ baselineAt: '2026-09-19T00:00:00.000Z' }));
  const base = { event: 'issue.opened' as const, timestamp: '2026-09-19T01:00:00.000Z', tieBreaker: '1', association, provider: 'jira' as const, issueId: '123', key: 'P-1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', labels: [], status: 'todo', change: {} };
  const candidates = [{ ...base, eventId: 'without-bug' }, { ...base, eventId: 'with-bug', labels: ['bug'] }];
  const launchTracker = vi.fn(async () => ({ runId: 'run' }));
  const scheduler = new ProjectTrackerAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, launchTracker,
    tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents: async () => ({ candidates, checkpoint: 'done', complete: true }) }) },
  });
  await scheduler.check(definition, 'preview');
  expect(launchTracker).not.toHaveBeenCalled();
  await scheduler.check(definition);
  await scheduler.check(definition);
  expect(launchTracker).toHaveBeenCalledTimes(1);
  expect(store.latestReceipts().size).toBe(1);
  expect(store.state(definition.id)?.checkpoint).toBe('done');
});

it.each(['not_configured', 'credentials_missing'] as const)('backs off without launching when tracker is %s', async code => {
  const { ProjectTrackerAutomationScheduler } = await import('./scheduler.ts');
  const { TrackerPoller } = await import('./tracker-poller.ts');
  const store = AutomationStore.open(mkdtempSync(join(tmpdir(), 'missing-tracker-')));
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const definition = store.create({ kind: 'tracker', enabled: true, name: 'test', intervalSeconds: 1800, trackerTrigger: { association, events: ['issue.opened'] }, task: { prompt: 'test' } }) as import('./types.ts').TrackerAutomationDefinition;
  const launchTracker = vi.fn();
  const poller = new TrackerPoller();
  const poll = vi.spyOn(poller, 'poll');
  const scheduler = new ProjectTrackerAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, launchTracker,
    tracker: { poller, getDriver: async () => ({ available: false, code, reason: 'Connect in Settings' }) },
  });
  await expect(scheduler.check(definition)).rejects.toThrow('Connect in Settings');
  expect(launchTracker).not.toHaveBeenCalled();
  expect(poll).not.toHaveBeenCalled();
  expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 1, backoffUntil: expect.any(String) });
});

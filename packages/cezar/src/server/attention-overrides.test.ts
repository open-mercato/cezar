import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attentionOverridesResponseSchema, attentionResponseSchema, healthResponseSchema } from '@open-mercato/cezar-contract';
import { createAttentionOverrideStore } from '../attention/overrides.ts';
import { createPrEndMemory } from '../attention/pr-ends.ts';
import { ATTENTION_SETTLE_MS } from '../attention/service.ts';
import { __clearRefStatusCacheForTests, __seedRefStatusCacheForTests } from './forge/github.ts';
import { RunStore } from '../runs/store.ts';
import { runInRelayScope } from '../relay/scope.ts';
import type { RunManager } from '../workflows/run.ts';
import { reportPrClosed } from './forge/pr-closed.ts';
import { RelayService } from '../relay/service.ts';
import { createApp, WorkspaceEventBus } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

const DAY = 24 * 60 * 60_000;

// Needs you triage (spec 2026-11-23-needs-you-triage): the override routes, end to end.
describe('attention override routes', () => {
  const savedDry = process.env.CEZ_DRY_RUN;
  let repoRoot: string;
  let store: RunStore;
  let quietRunId: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-attention-overrides-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const run = store.createRun({ title: 'Fix login', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'waiting', waitingSince: new Date().toISOString() });
    // Past the default Older days (7): Probably done.
    quietRunId = store.createRun({ title: 'Old wait', workflow: 'quick-task', task: 't', steps: [] }).id;
    store.updateRun(quietRunId, { status: 'waiting' });
    // The store stamps the wait's start on the status change; this one began nine days ago.
    store.updateRun(quietRunId, { waitingSince: new Date(Date.now() - 9 * DAY).toISOString() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDry;
  });

  const build = () => {
    const workspaceEvents = new WorkspaceEventBus();
    const events: string[] = [];
    workspaceEvents.on((event) => { if (event === 'attention-change') events.push(event); });
    const attentionOverrides = createAttentionOverrideStore(() => join(repoRoot, 'attention-overrides.json'));
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', attentionOverrides, workspaceEvents });
    const list = async () => attentionResponseSchema.strict().parse(await (await apiRequest(app, '/api/v1/workspace/attention')).json());
    const post = async (path: string, body: unknown) => {
      const response = await apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as unknown };
    };
    const phoneCount = async () => (await runInRelayScope({ deviceId: 'phone' }, async () =>
      healthResponseSchema.parse(await (await apiRequest(app, '/api/v1/health')).json()))).attention?.waiting;
    return { app, list, post, events, phoneCount };
  };

  it('hides a dismissed item from the list, its count and the phone, and brings it back on clear', async () => {
    const { list, post, events, phoneCount } = build();
    const before = await list();
    const task = before.items.find((item) => item.kind === 'task' && !item.settled)!;
    expect(before.counts.total).toBe(1);
    expect(await phoneCount()).toBe(1);

    const set = await post('/api/v1/workspace/attention/overrides', { key: task.key, mode: 'dismiss', projectId: task.projectId, runId: task.runId });
    expect(set.status).toBe(200);
    expect(attentionOverridesResponseSchema.parse(set.body).overrides).toMatchObject([{ key: task.key, runId: task.runId }]);
    const hidden = await list();
    expect(hidden.items.some((item) => item.key === task.key)).toBe(false);
    expect(hidden.counts.total).toBe(0);
    expect(await phoneCount()).toBe(0);
    // The cockpit hears it, not only a phone.
    expect(events.length).toBeGreaterThan(0);

    expect((await post('/api/v1/workspace/attention/overrides/clear', { key: task.key })).status).toBe(200);
    expect((await list()).counts.total).toBe(1);
  }, 30_000);

  it('snoozes until a time, and wakes the cockpit when the snooze ends', async () => {
    const { list, post, events } = build();
    const task = (await list()).items.find((item) => item.kind === 'task' && !item.settled)!;
    const until = new Date(Date.now() + 200).toISOString();
    expect((await post('/api/v1/workspace/attention/overrides', { key: task.key, mode: 'dismiss', until })).status).toBe(200);
    expect((await list()).items.some((item) => item.key === task.key)).toBe(false);
    events.length = 0;
    // The wake fires a second after the snooze ends, with no read in between.
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 4_000, interval: 50 });
    expect((await list()).items.some((item) => item.key === task.key)).toBe(true);
  }, 30_000);

  it('"keep" puts a Probably done item back in the count', async () => {
    const { list, post } = build();
    const quiet = (await list()).items.find((item) => item.runId === quietRunId)!;
    expect(quiet.settled?.why).toBe('quiet');
    expect(quiet.settled?.detail).toBe('Quiet for 9 days');
    await post('/api/v1/workspace/attention/overrides', { key: quiet.key, mode: 'keep' });
    const kept = (await list()).items.find((item) => item.runId === quietRunId)!;
    expect(kept.settled).toBeUndefined();
    expect(kept.counted).toBe(true);
  }, 30_000);

  it('refuses a bad mode, a malformed until, and an empty or oversized key', async () => {
    const { post } = build();
    const path = '/api/v1/workspace/attention/overrides';
    expect((await post(path, { key: 'k', mode: 'hide' })).status).toBe(400);
    expect((await post(path, { key: 'k', mode: 'dismiss', until: 'tomorrow' })).status).toBe(400);
    expect((await post(path, { key: '', mode: 'dismiss' })).status).toBe(400);
    expect((await post(path, { key: 'k'.repeat(401), mode: 'dismiss' })).status).toBe(400);
    expect((await post(`${path}/clear`, { key: '' })).status).toBe(400);
  }, 30_000);

  it('tells the cockpit when a PR closes', () => {
    const { events } = build();
    reportPrClosed(repoRoot, 5, 'merged');
    expect(events).toEqual(['attention-change']);
  }, 30_000);

  it('a PR-based Probably done outlives the forge cache, until a fresh read finds the PR open (review 2, finding 1)', async () => {
    const run = store.createRun({ title: 'Paused on #7', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
    store.recordPrRef(run.id, { number: 7, origin: 'marker' });
    // A fresh memory per boot: each one reads the file back, as a restart does (review of #2443, finding 2).
    const boot = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test',
      prEnds: createPrEndMemory(() => join(repoRoot, 'attention-pr-ends.json')),
      attentionOverrides: createAttentionOverrideStore(() => join(repoRoot, 'attention-overrides.json')) });
    const settledOf = async (app: ReturnType<typeof boot>) => attentionResponseSchema.parse(await (await apiRequest(app, '/api/v1/workspace/attention')).json())
      .items.find((item) => item.runId === run.id)?.settled;
    try {
      __seedRefStatusCacheForTests(repoRoot, [[7, { kind: 'pr', status: 'merged', endedAt: new Date(Date.now() + 1000).toISOString() }]]);
      expect(await settledOf(boot())).toEqual({ why: 'pr-merged', detail: 'PR #7 merged' });
      // A restart: the forge cache is empty, the verdict stays, read back from the file.
      expect(readFileSync(join(repoRoot, 'attention-pr-ends.json'), 'utf8')).toContain('"merged"');
      __clearRefStatusCacheForTests();
      expect(await settledOf(boot())).toEqual({ why: 'pr-merged', detail: 'PR #7 merged' });
      // Reopened, as a fresh read says: live again, and forgotten.
      __seedRefStatusCacheForTests(repoRoot, [[7, { kind: 'pr', status: 'review-required' }]]);
      expect(await settledOf(boot())).toBeUndefined();
      __clearRefStatusCacheForTests();
      expect(await settledOf(boot())).toBeUndefined();
    } finally {
      __clearRefStatusCacheForTests();
    }
  }, 30_000);

  it('tells the cockpit at once while a phone listens, a re-snooze included (review of #2443, finding 1)', async () => {
    const wants = vi.spyOn(RelayService.prototype, 'wantsCounts').mockReturnValue(true);
    const pushed = vi.spyOn(RelayService.prototype, 'noteAttentionChange');
    try {
      const { list, post, events } = build();
      const task = (await list()).items.find((item) => item.kind === 'task' && !item.settled)!;
      events.length = 0;
      await post('/api/v1/workspace/attention/overrides', { key: task.key, mode: 'dismiss', until: new Date(Date.now() + 3_600_000).toISOString() });
      expect(events).toEqual(['attention-change']);
      // Moving only the snooze's end leaves the item list alone, and is still news for the cockpit.
      await post('/api/v1/workspace/attention/overrides', { key: task.key, mode: 'dismiss', until: new Date(Date.now() + 7_200_000).toISOString() });
      expect(events).toEqual(['attention-change', 'attention-change']);
      // The recount the posts started (ATTENTION_SETTLE_MS later) is the phone's: it ran and pushed,
      // and it added no third event.
      await vi.waitFor(() => expect(pushed).toHaveBeenCalled(), { timeout: ATTENTION_SETTLE_MS + 3_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events).toEqual(['attention-change', 'attention-change']);
    } finally {
      wants.mockRestore();
      pushed.mockRestore();
    }
  }, 30_000);
});


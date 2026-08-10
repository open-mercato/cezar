import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * The LIVE-SERVER health path (spec `2026-07-23-websocket-subscriptions.md`).
 *
 * `createApp` only builds the health cache, the pre-warm and the `health` topic
 * when a `socketHub` is injected — which `startServer` does and no other suite
 * did, so every other server test exercises the hub-less fall-through (the old
 * compute-per-request behavior) and none of this code ran under test at all.
 * That is what these cover: the stale-while-revalidate policy AND its staleness
 * ceiling, the in-flight dedupe, publish-only-on-change, and the topic's
 * start/stop symmetry.
 */

/** A hub that records what `createApp` registers, so the test can drive the topic by hand. */
function stubHub() {
  const topics = new Map<string, TopicPublisher>();
  const hub: SocketHub = {
    registerTopic: (name, publisher) => {
      topics.set(name, publisher);
    },
    attach: () => undefined,
    close: () => undefined,
  };
  return { hub, topics };
}

describe('health topic + cache (live-server path)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-health-topic-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // Keeps the CLI/forge probes off the network so the payload is deterministic.
    process.env.CEZ_DRY_RUN = '1';
    // Health's `repoRoot` is trimmed in hosted mode, so an ambient CEZ_REMOTE on the dev box
    // must not decide what these assertions see.
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    vi.restoreAllMocks();
  });

  /** `defaultRunner` comes from `.ai/cezar/config.json`, so writing it is a cheap way to
   *  change what a fresh snapshot would say without touching git or the CLI probes. */
  const setRunner = (runner: string): void => {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: runner }));
  };

  const build = () => {
    const { hub, topics } = stubHub();
    const deps: ServerDeps = {
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      socketHub: hub,
    };
    return { app: createApp(deps), topics };
  };

  /**
   * The boot pre-warm is fire-and-forget; wait for it to land before asserting on the cache.
   *
   * The budget is explicit because `vi.waitFor` defaults to 1000ms and the snapshot this waits on is
   * the one the pre-warm exists for — a cold compute that probes git and the agent CLIs, which the
   * comment at its call site in `server.ts` measures at ~1s. Leaning on the default made this whole
   * suite flaky under load: eight failures, all "Timed out in waitFor", on a machine doing anything
   * else. Ten seconds is far past a real answer while still failing a hung one.
   */
  const settle = async (): Promise<void> => {
    await vi.waitFor(async () => {
      expect(await runner()).toBeDefined();
    }, { timeout: 10_000 });
  };
  let currentApp: ReturnType<typeof createApp> | undefined;
  const runner = async (): Promise<string | undefined> => {
    const res = await apiRequest(currentApp!, '/api/v1/health');
    expect(res.status).toBe(200);
    return ((await res.json()) as { defaultRunner?: string }).defaultRunner;
  };

  it('registers exactly one `health` topic', () => {
    const { topics } = build();
    expect([...topics.keys()]).toEqual(['health']);
  });

  it('pre-warms the cache at boot so the first GET is already warm', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    await settle();
    expect(await runner()).toBe('claude');
  });

  // The regression this file exists for: the 5 s TTL says how often a revalidation is KICKED
  // OFF, not how old the served value may be — the revalidation is fire-and-forget. With no
  // subscriber (a background `cezar serve` with no tab open) nothing else refreshes the cache,
  // so without a ceiling the next GET could answer with the boot payload an hour later.
  it('does not serve a payload older than the staleness ceiling', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    await settle();

    setRunner('codex');
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1_000); // two hours later

    // Waits for the recompute rather than answering from a two-hour-old cache.
    expect(await runner()).toBe('codex');
  });

  it('still answers instantly from cache inside the TTL', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    await settle();

    setRunner('codex');
    // Within the 5 s TTL the cached value is the point — no recompute, no wait.
    expect(await runner()).toBe('claude');
  });

  it('serves the cached value while revalidating in the stale-but-not-expired window', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    await settle();

    setRunner('codex');
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10_000); // > TTL, < ceiling

    expect(await runner()).toBe('claude'); // stale served immediately…
    clock.mockReturnValue(realNow + 10_001);
    // …and the refresh lands behind it. Same explicit budget as `settle`, for the same reason: this
    // waits on a full cold snapshot compute, which outlives `waitFor`'s 1s default under load.
    await vi.waitFor(async () => expect(await runner()).toBe('codex'), { timeout: 10_000 });
  });

  it('publishes to subscribers only when the payload actually changed', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    const published: unknown[] = [];
    const stop = health.start((data) => published.push(data));
    try {
      // A refresh that finds nothing new must not wake every subscriber's reducer.
      const realNow = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1_000);
      await runner();
      expect(published).toHaveLength(0);

      setRunner('codex');
      clock.mockReturnValue(realNow + 4 * 60 * 60 * 1_000);
      await runner();
      expect(published).toHaveLength(1);
      expect((published[0] as { defaultRunner?: string }).defaultRunner).toBe('codex');
    } finally {
      stop();
    }
  });

  it('stops publishing once the last subscriber leaves', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    const published: unknown[] = [];
    health.start((data) => published.push(data))(); // start, then immediately stop

    setRunner('codex');
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1_000);
    await runner();
    expect(published).toHaveLength(0);
  });

  it('the topic snapshot and GET /api/v1/health serve the same payload', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    const viaSocket = await health.snapshot();
    const response = await apiRequest(app, '/api/v1/health');
    expect(await response.json()).toEqual(viaSocket);
  });

  it('shares one compute between concurrent reads (in-flight dedupe)', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1_000);
    // Both are past the ceiling, so both take the awaited-refresh path; the dedupe means they
    // resolve from ONE snapshot rather than racing two sets of CLI spawns.
    const [a, b] = await Promise.all([health.snapshot(), health.snapshot()]);
    expect(a).toBe(b); // the very same object — one compute
  });

  it('a hub-less app is unchanged: no cache, every request computes fresh', async () => {
    setRunner('claude');
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    currentApp = app;
    expect(await runner()).toBe('claude');
    setRunner('codex');
    expect(await runner()).toBe('codex'); // no cache in the way
  });
});

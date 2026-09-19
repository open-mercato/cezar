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
    // The cache's whole policy is clock arithmetic — `Date.now() - healthCache.at` against the
    // TTL and the staleness ceiling — so the clock is the thing these cases need to steer, and
    // vitest's fake-timer API is how you steer it. `toFake: ['Date']` is deliberate and is the
    // only part of that API this suite may use: the code under test `await`s REAL child
    // processes (`git`, the agent-CLI `--version` probes) and real fs. Fake `setTimeout` /
    // `setInterval` / `nextTick` too and nothing is left to advance the clock while those
    // awaits are pending, so the suite would deadlock rather than run faster. Faking `Date`
    // alone replaces the hand-rolled `vi.spyOn(Date, 'now')` mocks this file used to carry:
    // one clock, moved with `vi.setSystemTime`, consistent across `Date.now()` and `new Date()`
    // instead of a single method patched out from under the code.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  /** One health snapshot spawns the CLI/forge probes and shells out to git, which costs
   *  ~1 s on a warm dev box and several seconds on a loaded CI runner. `vi.waitFor` defaults
   *  to a 1 s budget and a test to 5 s, so both had to be beaten by a probe sweep to pass —
   *  that is the whole flake (#701 class): these assertions are about cache POLICY, never
   *  about how fast a probe answers. The budget is generous on purpose; a genuinely broken
   *  pre-warm never resolves and still fails, just later. It supersedes the interim 10 s
   *  `waitFor` budget, which `main` could never actually spend: the enclosing case still ran
   *  under vitest's 5 s default and died first.
   *
   *  Note this survives the fake clock above, and has to: what these waits are waiting on is a
   *  child process finishing, not a timer firing. `vi.setSystemTime` can move the cache's
   *  notion of "now" by two hours in a microsecond, but it cannot make `git` answer sooner,
   *  so the budget guards the one thing a clock mock is powerless over. */
  const PROBE_BUDGET_MS = 30_000;
  /** Per-test ceiling: a case may need a pre-warm sweep plus a couple of recomputes, and
   *  vitest's 5 s default cuts that off long before the policy under test has a verdict. */
  const TEST_BUDGET_MS = 60_000;

  /**
   * The boot pre-warm is fire-and-forget; wait for it to land before asserting on the cache,
   * then hand back the moment it landed as the baseline every clock move is expressed against.
   *
   * Returning that baseline is the point. Cases used to read the real `Date.now()` for
   * themselves after settling, which left the cached entry's age at whatever the pre-warm
   * happened to cost — so "inside the TTL" held only while a probe sweep finished inside 5 s,
   * the exact assumption this file exists to stop relying on. The fake clock stands still once
   * the wait returns, so a case that starts from this baseline states the age it is testing
   * (`+10 s`, `+2 h`) instead of inheriting one from the machine.
   *
   * (`vi.waitFor` nudges an installed fake clock by one poll interval per poll, so the clock
   * does drift forward at roughly real-time pace *during* a wait. That is bounded and far below
   * the 60 s ceiling — it would take ~1000 polls to reach it — and it stops on return, which is
   * why the baseline is read after the wait rather than before it.)
   */
  const settle = async (): Promise<number> => {
    await vi.waitFor(
      async () => {
        expect(await runner()).toBeDefined();
      },
      { timeout: PROBE_BUDGET_MS, interval: 50 },
    );
    return Date.now();
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
  }, TEST_BUDGET_MS);

  // The regression this file exists for: the 5 s TTL says how often a revalidation is KICKED
  // OFF, not how old the served value may be — the revalidation is fire-and-forget. With no
  // subscriber (a background `cezar serve` with no tab open) nothing else refreshes the cache,
  // so without a ceiling the next GET could answer with the boot payload an hour later.
  it('does not serve a payload older than the staleness ceiling', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    const warmedAt = await settle();

    setRunner('codex');
    vi.setSystemTime(warmedAt + 2 * 60 * 60 * 1_000); // two hours later

    // Waits for the recompute rather than answering from a two-hour-old cache.
    expect(await runner()).toBe('codex');
  }, TEST_BUDGET_MS);

  it('still answers instantly from cache inside the TTL', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    await settle();

    setRunner('codex');
    // Within the 5 s TTL the cached value is the point — no recompute, no wait. The clock is
    // frozen at the pre-warm, so the entry's age is ~0 by construction rather than "however
    // long the probes took, hopefully under 5 s".
    expect(await runner()).toBe('claude');
  }, TEST_BUDGET_MS);

  it('serves the cached value while revalidating in the stale-but-not-expired window', async () => {
    setRunner('claude');
    const { app } = build();
    currentApp = app;
    const warmedAt = await settle();

    setRunner('codex');
    vi.setSystemTime(warmedAt + 10_000); // > TTL, < ceiling

    expect(await runner()).toBe('claude'); // stale served immediately…
    vi.setSystemTime(warmedAt + 10_001);
    // …and the refresh lands behind it — within a probe sweep, not within the 1 s default.
    // Same explicit budget as `settle`, for the same reason: this waits on a full cold
    // snapshot compute, which outlives `waitFor`'s default under load.
    await vi.waitFor(async () => expect(await runner()).toBe('codex'), {
      timeout: PROBE_BUDGET_MS,
      interval: 50,
    });
  }, TEST_BUDGET_MS);

  it('publishes to subscribers only when the payload actually changed', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    const warmedAt = await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    const published: unknown[] = [];
    const stop = health.start((data) => published.push(data));
    try {
      // A refresh that finds nothing new must not wake every subscriber's reducer.
      vi.setSystemTime(warmedAt + 2 * 60 * 60 * 1_000);
      await runner();
      expect(published).toHaveLength(0);

      setRunner('codex');
      vi.setSystemTime(warmedAt + 4 * 60 * 60 * 1_000);
      await runner();
      expect(published).toHaveLength(1);
      expect((published[0] as { defaultRunner?: string }).defaultRunner).toBe('codex');
    } finally {
      stop();
    }
  }, TEST_BUDGET_MS);

  it('stops publishing once the last subscriber leaves', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    const warmedAt = await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    const published: unknown[] = [];
    health.start((data) => published.push(data))(); // start, then immediately stop

    setRunner('codex');
    vi.setSystemTime(warmedAt + 2 * 60 * 60 * 1_000);
    await runner();
    expect(published).toHaveLength(0);
  }, TEST_BUDGET_MS);

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
  }, TEST_BUDGET_MS);

  it('shares one compute between concurrent reads (in-flight dedupe)', async () => {
    setRunner('claude');
    const { app, topics } = build();
    currentApp = app;
    const warmedAt = await settle();

    const health = topics.get('health');
    if (!health) throw new Error('no health topic registered');
    vi.setSystemTime(warmedAt + 2 * 60 * 60 * 1_000);
    // Both are past the ceiling, so both take the awaited-refresh path; the dedupe means they
    // resolve from ONE snapshot rather than racing two sets of CLI spawns.
    const [a, b] = await Promise.all([health.snapshot(), health.snapshot()]);
    expect(a).toBe(b); // the very same object — one compute
  }, TEST_BUDGET_MS);

  it('a hub-less app is unchanged: no cache, every request computes fresh', async () => {
    setRunner('claude');
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    currentApp = app;
    expect(await runner()).toBe('claude');
    setRunner('codex');
    expect(await runner()).toBe('codex'); // no cache in the way
  }, TEST_BUDGET_MS);
});

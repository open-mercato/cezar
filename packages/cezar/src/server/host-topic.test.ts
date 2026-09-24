import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostUsageSchema, type HostUsage } from '@open-mercato/cezar-contract';
import { setAdmissionStatusProvider } from '../core/admission-status.ts';
import { HOST_SAMPLE_INTERVAL_MS, hostUsageSampler } from '../core/host-usage.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import type { SocketHub, TopicOptions, TopicPublisher } from './ws.ts';

/**
 * The `host` topic (spec `.ai/specs/2026-09-20-host-resource-telemetry.md`).
 *
 * `createApp` registers it only when a `socketHub` is injected — the live-server path — so the
 * topic has to be driven by hand through a recording hub, the same way `health-topic.test.ts`
 * does. What matters here is the CONTRACT of the registration: the sampler's 0→1/1→0 lifecycle
 * owns the timer, one tick is one publish, the first frame carries no `cpuPct`, and the topic
 * stays trusted-only (the default) because host totals are not a discovery payload.
 */

function stubHub() {
  const topics = new Map<string, { publisher: TopicPublisher; options?: TopicOptions }>();
  const hub: SocketHub = {
    registerTopic: (name, publisher, options) => {
      topics.set(name, { publisher, options });
    },
    attach: () => undefined,
    close: () => undefined,
  };
  return { hub, topics };
}

describe('host topic + sampler (live-server path)', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-host-topic-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    hostUsageSampler.dispose();
  });

  afterEach(() => {
    // The governor's provider is module state: a test that registers one must not leave it behind.
    setAdmissionStatusProvider(undefined);
    hostUsageSampler.dispose();
    vi.useRealTimers();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const build = () => {
    const { hub, topics } = stubHub();
    const app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      socketHub: hub,
    });
    const topic = topics.get('host');
    if (!topic) throw new Error('no host topic registered');
    return { app, topic };
  };

  /**
   * A sampler whose frames the test owns. CI machines have no cgroup limit, so the container
   * branches of the wire contract have to be driven by a fixture rather than by the machine.
   */
  const buildWithSample = (sample: HostUsage) => {
    const { hub, topics } = stubHub();
    const app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      socketHub: hub,
      hostSampler: {
        currentHostUsage: () => sample,
        sampleHostUsage: () => sample,
        onHostUsage: () => () => undefined,
        dispose: () => undefined,
      },
    });
    const topic = topics.get('host');
    if (!topic) throw new Error('no host topic registered');
    return { app, topic };
  };

  const baseSample = {
    sampledAt: '2026-09-20T00:00:00.000Z',
    cpuCount: 8,
    memTotalBytes: 16 * 1024 ** 3,
    memUsedBytes: 4 * 1024 ** 3,
    memAvailableBytes: 12 * 1024 ** 3,
  };

  it('registers the host topic trusted-only, beside health', () => {
    const { hub, topics } = stubHub();
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      socketHub: hub,
    });
    expect([...topics.keys()].sort()).toEqual(['health', 'host']);
    // Not a discovery payload: the loopback-origin fallback admits foreign local pages at the
    // handshake, so only an explicitly `loopbackReadable` topic may be read by one.
    expect(topics.get('host')?.options?.loopbackReadable ?? false).toBe(false);
  });

  it('answers the snapshot-before-first-tick frame without cpuPct', async () => {
    const { topic } = build();
    const frame = await topic.publisher.snapshot();
    expect(hostUsageSchema.safeParse(frame).success).toBe(true);
    expect((frame as { cpuPct?: number }).cpuPct).toBeUndefined();
  });

  it('publishes one contract-valid sample per tick and stops with the last subscriber', async () => {
    vi.useFakeTimers();
    const { topic } = build();
    const published: unknown[] = [];

    const stop = topic.publisher.start((data) => published.push(data));
    expect(published).toHaveLength(0); // priming a baseline is not a frame
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
    expect(published).toHaveLength(1);
    expect(hostUsageSchema.safeParse(published[0]).success).toBe(true);

    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
    expect(published).toHaveLength(2);
    const first = published[0] as { sampledAt: string };
    const second = published[1] as { sampledAt: string };
    expect(second.sampledAt).not.toBe(first.sampledAt);

    stop();
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS * 5);
    expect(published).toHaveLength(2); // 1→0 cleared the timer
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serves the same contract over the topic and the route', async () => {
    const { app, topic } = build();
    const viaSocket = (await topic.publisher.snapshot()) as Record<string, unknown>;
    const res = await app.request('/api/v1/workspace/host-usage', {
      headers: { host: '127.0.0.1:4321' },
    });
    expect(res.status).toBe(200);
    const viaRoute = (await res.json()) as Record<string, unknown>;
    // Both transports read the SAME sampler, so both must satisfy the schema; the required keys
    // are identical by construction, and the optional ones may legitimately differ between two
    // reads milliseconds apart (a nonzero CPU delta lands on the second one).
    expect(hostUsageSchema.safeParse(viaSocket).success).toBe(true);
    expect(hostUsageSchema.safeParse(viaRoute).success).toBe(true);
    for (const key of ['sampledAt', 'cpuCount', 'memTotalBytes', 'memUsedBytes', 'memAvailableBytes']) {
      expect(Object.keys(viaRoute)).toContain(key);
      expect(Object.keys(viaSocket)).toContain(key);
    }
  });

  it('carries a container frame over both transports, with hostCpuCount beside it', async () => {
    const sample = {
      ...baseSample,
      container: { source: 'cgroup-v2' as const, cpuQuotaCores: 2, memLimitBytes: 2 * 1024 ** 3 },
      hostCpuCount: 8,
    };
    const { app, topic } = buildWithSample(sample);

    const viaSocket = await topic.publisher.snapshot();
    expect(hostUsageSchema.safeParse(viaSocket).success).toBe(true);
    expect(viaSocket).toMatchObject({
      container: { source: 'cgroup-v2', cpuQuotaCores: 2 },
      hostCpuCount: 8,
    });

    const res = await app.request('/api/v1/workspace/host-usage', {
      headers: { host: '127.0.0.1:4321' },
    });
    expect(await res.json()).toEqual(sample);
  });

  it('carries an admission frame over both transports, verbatim', async () => {
    const sample = {
      ...baseSample,
      admission: {
        state: 'elevated' as const,
        configured: 4,
        effective: 2,
        since: '2026-09-20T00:00:00.000Z',
      },
    };
    const { app, topic } = buildWithSample(sample);

    const viaSocket = await topic.publisher.snapshot();
    const parsed = hostUsageSchema.safeParse(viaSocket);
    expect(parsed.success).toBe(true);
    // The PARSED object is the proof the schema knows the key: zod strips what a schema does not
    // declare, so a contract without `admission` would drop it here without ever failing.
    expect(parsed.success ? parsed.data.admission : undefined).toEqual(sample.admission);
    expect(viaSocket).toMatchObject({
      admission: { state: 'elevated', configured: 4, effective: 2 },
    });

    const res = await app.request('/api/v1/workspace/host-usage', {
      headers: { host: '127.0.0.1:4321' },
    });
    expect(await res.json()).toEqual(sample);
  });

  it('sends no additive keys at all on a usage-only host with no ceiling', async () => {
    const { topic } = buildWithSample({ ...baseSample });
    const frame = (await topic.publisher.snapshot()) as Record<string, unknown>;
    expect('container' in frame).toBe(false);
    expect('hostCpuCount' in frame).toBe(false);
    // No semaphore is registered here, so there is no ceiling to report and no `admission` key.
    expect('admission' in frame).toBe(false);
  });

  it('reads the semaphore snapshot through the real sampler, and stops when it goes away', async () => {
    const { app, topic } = build();
    const read = async (): Promise<Record<string, unknown>> => {
      const res = await app.request('/api/v1/workspace/host-usage', {
        headers: { host: '127.0.0.1:4321' },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    // The fixture tests above prove the wire contract; this one proves the sampler's own read,
    // which is the half that would silently stay absent if `buildSample` never asked.
    expect('admission' in (await read())).toBe(false);

    setAdmissionStatusProvider(() => ({
      state: 'critical',
      configured: 4,
      effective: 1,
      since: '2026-09-20T00:00:00.000Z',
    }));
    expect(await topic.publisher.snapshot()).toMatchObject({
      admission: { state: 'critical', configured: 4, effective: 1 },
    });
    expect(hostUsageSchema.safeParse(await read()).success).toBe(true);
    expect(await read()).toMatchObject({ admission: { state: 'critical', effective: 1 } });

    // Clearing the ceiling drops the key with it: the reduction never outlives its ceiling. The
    // last sample stays in the sampler's cache until it goes stale (the same bounded staleness
    // that governs `cpuPct`), so this asks for a fresh read rather than a cached one.
    setAdmissionStatusProvider(undefined);
    hostUsageSampler.dispose();
    expect('admission' in (await read())).toBe(false);
  });
});

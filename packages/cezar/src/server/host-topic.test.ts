import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostUsageSchema, type HostUsage } from '@open-mercato/cezar-contract';
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
      // `registerTopic` returns an idempotent disposer on main (dynamic topics); the stub has to
      // match the interface or the whole server typecheck fails.
      return () => {
        topics.delete(name);
      };
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

  it('sends no container keys at all on a usage-only host', async () => {
    const { topic } = buildWithSample({ ...baseSample });
    const frame = (await topic.publisher.snapshot()) as Record<string, unknown>;
    expect('container' in frame).toBe(false);
    expect('hostCpuCount' in frame).toBe(false);
  });
});

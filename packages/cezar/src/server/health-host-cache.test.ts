import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendCheck } from '../core/backend-detect.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';
import type { SocketHub } from './ws.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const counters = vi.hoisted(() => ({ detect: 0, repoInfo: 0 }));
const CHECKS: BackendCheck[] = [{ name: 'git', available: true, version: 'git version 2.x' }];

vi.mock('../core/backend-detect.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/backend-detect.ts')>();
  return {
    ...actual,
    detectEnvironment: async () => {
      counters.detect++;
      return CHECKS;
    },
  };
});

vi.mock('./git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git.ts')>();
  return {
    ...actual,
    getRepoInfo: async (dir: string) => {
      counters.repoInfo++;
      return actual.getRepoInfo(dir);
    },
  };
});

const hub: SocketHub = { registerTopic: () => () => {}, attach: () => undefined, close: () => undefined };

/** Past the health cache's 60 s staleness ceiling, so every read below waits for a real recompute. */
const TICK_MS = 61_000;
const HOST_PROBE_TTL_MS = 5 * 60_000;
const READS = 4;

describe('health host probes (live-server path)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(async () => {
    counters.detect = 0;
    counters.repoInfo = 0;
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-health-host-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const build = (extra: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', socketHub: hub, ...extra });

  const health = async (app: ReturnType<typeof createApp>) => {
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.status).toBe(200);
    return (await res.json()) as { checks: BackendCheck[]; repo: { branch: string; remote?: string } | null };
  };

  /** Waits out the boot pre-warm, then reads health READS times, each past the staleness ceiling. */
  const readAcrossTicks = async (app: ReturnType<typeof createApp>) => {
    await vi.waitFor(async () => expect((await health(app)).repo).not.toBeNull(), { timeout: 30_000, interval: 50 });
    const before = { ...counters };
    for (let i = 0; i < READS; i++) {
      vi.setSystemTime(Date.now() + TICK_MS);
      await health(app);
    }
    return { detect: counters.detect - before.detect, repoInfo: counters.repoInfo - before.repoInfo };
  };

  it('a health tick re-reads neither the host CLIs nor the repo identity', async () => {
    const perTick = await readAcrossTicks(build());
    expect(perTick).toEqual({ detect: 0, repoInfo: 0 });
  }, 60_000);

  it('the boot probe seeds the cache, so health never runs detectEnvironment itself', async () => {
    const app = build({ hostChecks: Promise.resolve(CHECKS) });
    expect((await health(app)).checks).toEqual(CHECKS);
    await readAcrossTicks(app);
    expect(counters.detect).toBe(0);
  }, 60_000);

  it('the branch still follows a checkout on the next tick', async () => {
    const app = build();
    await readAcrossTicks(app);
    await run('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: repoRoot });
    vi.setSystemTime(Date.now() + TICK_MS);
    expect((await health(app)).repo?.branch).toBe('feature/x');
  }, 60_000);

  it('"Check again" on provider status re-probes the host checks on the next read', async () => {
    const app = build();
    await readAcrossTicks(app);
    const before = counters.detect;
    expect((await apiRequest(app, '/api/v1/providers/status?refresh=1')).status).toBe(200);
    vi.setSystemTime(Date.now() + TICK_MS);
    await health(app);
    expect(counters.detect).toBe(before + 1);
  }, 60_000);

  it('"Check again" on provider status makes a newly added remote reach health on the next read', async () => {
    const app = build();
    await readAcrossTicks(app);
    await run('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: repoRoot });
    vi.setSystemTime(Date.now() + TICK_MS);
    expect((await health(app)).repo?.remote).toBeUndefined();
    expect((await apiRequest(app, '/api/v1/providers/status?refresh=1')).status).toBe(200);
    vi.setSystemTime(Date.now() + TICK_MS);
    expect((await health(app)).repo?.remote).toBe('https://github.com/example/repo.git');
  }, 60_000);

  it('a read past the host-probe TTL revalidates exactly once, behind the answer', async () => {
    const app = build();
    await readAcrossTicks(app);
    const before = { ...counters };
    vi.setSystemTime(Date.now() + HOST_PROBE_TTL_MS);
    await health(app);
    await vi.waitFor(() => expect(counters.detect - before.detect).toBe(1), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(counters.repoInfo - before.repoInfo).toBe(1), { timeout: 10_000, interval: 20 });
    for (let i = 0; i < READS; i++) {
      vi.setSystemTime(Date.now() + TICK_MS);
      await health(app);
    }
    expect({ detect: counters.detect - before.detect, repoInfo: counters.repoInfo - before.repoInfo }).toEqual({ detect: 1, repoInfo: 1 });
  }, 60_000);

  it('an idle serve answers the first read past the ceiling fresh, not one read behind it', async () => {
    const app = build();
    await vi.waitFor(async () => expect((await health(app)).repo).not.toBeNull(), { timeout: 30_000, interval: 50 });
    const before = counters.detect;
    await run('git', ['remote', 'add', 'origin', 'https://github.com/example/late.git'], { cwd: repoRoot });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    // The host facts sat unread for an hour. This ONE read must observe them, not the next one.
    expect((await health(app)).repo?.remote).toBe('https://github.com/example/late.git');
    expect(counters.detect).toBe(before + 1);
  }, 60_000);
});

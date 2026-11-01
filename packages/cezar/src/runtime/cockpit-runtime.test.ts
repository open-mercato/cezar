import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimCockpitSlot,
  cockpitRuntimeDirectory,
  inspectCockpitRuntime,
  instanceCockpitSlot,
  publishCockpitRuntime,
  readCockpitRuntime,
  releaseCockpitRuntime,
  remoteCockpitSlot,
  resolveCockpitSlot,
} from './cockpit-runtime.ts';

const health = (runtimeId: string) => ({
  version: '0.0.0-test',
  runtimeId,
  repoRoot: '/tmp/repo',
  repo: null,
  checks: [],
  defaultRunner: 'codex',
  forge: null,
  capabilities: {
    localHandoff: true,
    terminal: false,
    designMode: false,
    followups: false,
    singleProject: false,
    automations: true,
    webhooks: false,
    dispatch: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
  },
  projects: [],
  bootProject: 'default',
});

describe('cockpit runtime lease', () => {
  let home: string;
  const originalHome = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-cockpit-runtime-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps role slots distinct and hashes arbitrary instance identities', () => {
    expect(resolveCockpitSlot({ port: 4321, env: {} })).toBe('interactive');
    expect(resolveCockpitSlot({ port: 4321, env: { CEZ_INSTANCE_ID: 'shop/../prod' } }))
      .toBe(instanceCockpitSlot('shop/../prod'));
    expect(instanceCockpitSlot('shop/../prod')).not.toBe(instanceCockpitSlot('shop-prod'));
    expect(resolveCockpitSlot({ port: 4321, bindHost: '0.0.0.0', env: { CEZ_REMOTE: '1' } }))
      .toBe(remoteCockpitSlot('0.0.0.0', 4321));
    expect(remoteCockpitSlot('0.0.0.0', 4321)).not.toBe(remoteCockpitSlot('127.0.0.1', 4321));
  });

  it('allows one owner, publishes a private token-matching record, and releases it', async () => {
    const first = await claimCockpitSlot('interactive');
    expect(first.kind).toBe('primary');
    if (first.kind !== 'primary') return;
    expect((await claimCockpitSlot('interactive')).kind).toBe('secondary');

    const runtime = await publishCockpitRuntime(first.lease, {
      runtimeId: '00000000-0000-4000-8000-000000000001',
      port: 4321,
      version: '0.0.0-test',
    });
    expect((await readCockpitRuntime('interactive'))?.runtimeId).toBe(runtime.runtimeId);
    expect(runtime.owner.token).toBe(first.lease.ownership.identity.token);
    expect(statSync(join(cockpitRuntimeDirectory('interactive'), 'runtime.json')).mode & 0o777).toBe(0o600);

    await releaseCockpitRuntime(first.lease);
    expect(await readCockpitRuntime('interactive')).toBeUndefined();
    const next = await claimCockpitSlot('interactive');
    expect(next.kind).toBe('primary');
    if (next.kind === 'primary') await releaseCockpitRuntime(next.lease);
  });

  it('trusts only a live owner whose health echoes the recorded runtime identity', async () => {
    const claimed = await claimCockpitSlot('interactive');
    expect(claimed.kind).toBe('primary');
    if (claimed.kind !== 'primary') return;
    const runtimeId = '00000000-0000-4000-8000-000000000002';
    await publishCockpitRuntime(claimed.lease, { runtimeId, port: 4321, version: '0.0.0-test' });

    const matching = await inspectCockpitRuntime('interactive', {
      fetcher: async () => new Response(JSON.stringify(health(runtimeId)), { status: 200 }),
    });
    expect(matching.kind).toBe('verified');

    const mismatch = await inspectCockpitRuntime('interactive', {
      fetcher: async () => new Response(JSON.stringify(health('00000000-0000-4000-8000-000000000003')), { status: 200 }),
    });
    expect(mismatch).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('does not match') });

    const raw = JSON.parse(readFileSync(join(cockpitRuntimeDirectory('interactive'), 'runtime.json'), 'utf8'));
    expect(raw.owner.pid).toBe(process.pid);
    await releaseCockpitRuntime(claimed.lease);
  });

  it('recovers a corrupt runtime projection after its exact owner is provably dead', async () => {
    const claimed = await claimCockpitSlot('interactive');
    expect(claimed.kind).toBe('primary');
    if (claimed.kind !== 'primary') return;
    const identity = claimed.lease.ownership.identity;
    await releaseCockpitRuntime(claimed.lease);

    writeFileSync(join(cockpitRuntimeDirectory('interactive'), 'owner.lock'), JSON.stringify({
      ...identity,
      token: '00000000-0000-4000-8000-000000000004',
      // Larger than every supported platform's PID ceiling, so absence is OS-provable.
      pid: 0x1_0000_0000,
    }));
    writeFileSync(join(cockpitRuntimeDirectory('interactive'), 'runtime.json'), '{broken');

    expect(await inspectCockpitRuntime('interactive')).toEqual({ kind: 'dead' });
    const replacement = await claimCockpitSlot('interactive');
    expect(replacement.kind).toBe('primary');
    if (replacement.kind === 'primary') {
      await publishCockpitRuntime(replacement.lease, {
        runtimeId: '00000000-0000-4000-8000-000000000005',
        port: 4321,
        version: '0.0.0-test',
      });
      await releaseCockpitRuntime(replacement.lease);
    }
  });
});

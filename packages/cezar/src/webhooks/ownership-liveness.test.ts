import { hostname, tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The liveness DECISION is pinned with injected probes: this host is Linux, and the Windows clock-step
// and foreign-PID-namespace cases cannot be produced here for real.
const probe = vi.hoisted(() => ({
  own: { pid: 4242, start: '1', boot: 'boot' } as { pid: number; start: string; boot: string; pidNamespace?: string },
  live: new Map<number, string>(),
  calls: 0,
  fail: false,
}));
vi.mock('./process-identity.ts', async importOriginal => ({
  bootIsStableId: (await importOriginal<typeof import('./process-identity.ts')>()).bootIsStableId,
  ownProcessIdentity: async () => probe.own,
  processStarts: async (pids: number[]) => {
    probe.calls++;
    if (probe.fail) throw new Error("Cannot verify process identity");
    return new Map(pids.flatMap(pid => probe.live.has(pid) ? [[pid, probe.live.get(pid)!] as const] : []));
  },
}));
import { acquireOwnership } from './ownership.ts';

const dirs: string[] = [];
beforeEach(() => { probe.live = new Map(); probe.calls = 0; probe.fail = false; });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-liveness-')); dirs.push(dir); return dir; };

const OWNER = '00000000-0000-4000-8000-000000000001';
const BOOT_A = '6f1c2a3b-0d4e-4f50-8a61-7b8c9d0e1f20';
const BOOT_B = '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e';
const WIN_START = '133700000000000000';
const NS_OWN = 'pid:[4026532001]', NS_OTHER = 'pid:[4026531836]';
// The owner pid differs from ours, so only the injected probe can say it is running.
const ownerAt = (dir: string, fields: Record<string, unknown>) =>
  writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ token: OWNER, pid: 777, start: '1337', host: hostname(), ...fields }));
const lockToken = (dir: string) => JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')).token as string;

describe('Windows: the boot token is a clock-derived instant, not a boot ID', () => {
  beforeEach(() => { probe.own = { pid: 4242, start: '133800000000000000', boot: '133600000000000000' }; });

  it('keeps a live owner whose boot ticks drifted with a clock step', async () => {
    const dir = scratch();
    // Same boot, but KeBootTime moved by the step after the owner wrote its identity.
    ownerAt(dir, { boot: '133599999990000000', start: WIN_START });
    probe.live.set(777, WIN_START);

    expect(await acquireOwnership(dir)).toBeUndefined();
    expect(lockToken(dir)).toBe(OWNER);
  });

  it('takes over after a real reboot, decided by the pid probe', async () => {
    const dir = scratch();
    ownerAt(dir, { boot: '133500000000000000', start: WIN_START });

    const owner = await acquireOwnership(dir);
    expect(owner?.recovered).toBe(true);
    expect(probe.calls).toBeGreaterThan(0);
    await owner!.release();
  });

  it('takes over when the pid was reused by a later process', async () => {
    const dir = scratch();
    ownerAt(dir, { boot: '133500000000000000', start: WIN_START });
    probe.live.set(777, '133750000000000000');

    const owner = await acquireOwnership(dir);
    expect(owner?.recovered).toBe(true);
    await owner!.release();
  });
});

describe('random boot IDs (Linux boot_id, macOS kern.bootsessionuuid)', () => {
  it('still proves a reboot without a probe', async () => {
    probe.own = { pid: 4242, start: '1', boot: BOOT_A };
    const dir = scratch();
    ownerAt(dir, { boot: BOOT_B, start: '1' });
    probe.live.set(777, '1');

    const owner = await acquireOwnership(dir);
    expect(owner?.recovered).toBe(true);
    await owner!.release();
  });
});

describe('Linux PID namespaces', () => {
  beforeEach(() => { probe.own = { pid: 4242, start: '1', boot: BOOT_A, pidNamespace: NS_OWN }; });

  it('records its own namespace in the identity it publishes', async () => {
    const owner = await acquireOwnership(scratch());
    expect(owner).toBeDefined();
    const dir = dirs.at(-1)!;
    expect(JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')).pidNamespace).toBe(NS_OWN);
    await owner!.release();
  });

  it('never takes over an owner in another namespace whose pid it cannot see', async () => {
    const dir = scratch();
    ownerAt(dir, { boot: BOOT_A, start: '5', pidNamespace: NS_OTHER });

    await expect(acquireOwnership(dir)).rejects.toThrow('Cannot verify foreign owner identity');
    expect(lockToken(dir)).toBe(OWNER);
  });

  it('fails closed on a legacy identity without a namespace that the probe does not see', async () => {
    const dir = scratch();
    ownerAt(dir, { boot: BOOT_A, start: '5' });

    await expect(acquireOwnership(dir)).rejects.toThrow('Cannot verify foreign owner identity');
    expect(lockToken(dir)).toBe(OWNER);
  });

  it('keeps a legacy owner the probe positively matches', async () => {
    const dir = scratch();
    ownerAt(dir, { boot: BOOT_A, start: '5' });
    probe.live.set(777, '5');

    expect(await acquireOwnership(dir)).toBeUndefined();
    expect(lockToken(dir)).toBe(OWNER);
  });

  it('takes over a dead owner in its own namespace', async () => {
    const dir = scratch();
    ownerAt(dir, { boot: BOOT_A, start: '5', pidNamespace: NS_OWN });

    const owner = await acquireOwnership(dir);
    expect(owner?.recovered).toBe(true);
    await owner!.release();
  });

  it('takes over across a reboot whatever the namespace says, legacy identities included', async () => {
    for (const namespace of [{}, { pidNamespace: NS_OTHER }]) {
      const dir = scratch();
      ownerAt(dir, { boot: BOOT_B, start: '5', ...namespace });
      probe.live.set(777, '5');

      const owner = await acquireOwnership(dir);
      expect(owner?.recovered).toBe(true);
      await owner!.release();
    }
  });

  it('leaves a foreign-namespace orphan in place instead of failing its own acquisition', async () => {
    const dir = scratch();
    const orphan = '00000000-0000-4000-8000-000000000009';
    const name = `owner-record-${orphan}.json`;
    const identity = { token: orphan, pid: 778, start: '5', boot: BOOT_A, host: hostname(), pidNamespace: NS_OTHER };
    writeFileSync(join(dir, name), JSON.stringify(identity));

    const owner = await acquireOwnership(dir);
    expect(owner?.valid()).toBe(true);
    expect(existsSync(join(dir, name))).toBe(true);
    await owner!.release();
  });
});

it('skips an unverifiable orphan without disabling acquisition or deleting it', async () => {
  probe.own = { pid: 4242, start: '1', boot: BOOT_A };
  probe.fail = true;
  const dir = scratch();
  const name = `owner-record-${OWNER}.json`;
  const raw = JSON.stringify({ token: OWNER, pid: 777, start: '5', boot: BOOT_A, host: hostname() });
  writeFileSync(join(dir, name), raw);
  const owner = await acquireOwnership(dir);
  expect(owner?.valid()).toBe(true);
  expect(readFileSync(join(dir, name), 'utf8')).toBe(raw);
  await owner!.release();
});
it('keeps an unverifiable published owner fenced', async () => {
  probe.own = { pid: 4242, start: '1', boot: BOOT_A };
  probe.fail = true;
  const dir = scratch();
  ownerAt(dir, { boot: BOOT_A });
  await expect(acquireOwnership(dir)).rejects.toThrow('Cannot verify process identity');
  expect(lockToken(dir)).toBe(OWNER);
});

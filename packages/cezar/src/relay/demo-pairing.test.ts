import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_LIFE_MS } from './pairing.ts';
import { RELAY_TERMS } from '@open-mercato/cezar-contract';
import { FakeRelay } from './fake-relay.testkit.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { RelayService, demoPairingCode } from './service.ts';

const ORIGIN = 'https://relay.example.test';
const CODE = 'DEMO-7K2P-9QXA';
/** Waiting AND its rendezvous open: the expiry is set only once the relay took it. */
const open = (service: RelayService) => service.list().pairing?.status === 'waiting' && Date.parse(service.list().pairing!.expiresAt) > 0;

describe('store-review demo code (CEZ_RELAY_DEMO_CODE)', () => {
  let directory: string;
  let relay: FakeRelay;
  let service: RelayService | undefined;

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 600 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  };
  const make = async (env: NodeJS.ProcessEnv) => {
    service = new RelayService({ directory, env: { CEZ_RELAY_URL: ORIGIN, ...env }, open: relay.open, accountPost: relay.accounts.post, label: 'Demo' });
    service.attach(async () => new Response('ok'), () => {});
    await service.refreshAddress();
    await service.setAccount('demo@example.test', RELAY_TERMS.version);
    await service.start();
    return service;
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-relay-demo-'));
    relay = new FakeRelay();
  });

  afterEach(() => {
    service?.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is ignored without CEZ_DRY_RUN=1', async () => {
    expect(demoPairingCode({ CEZ_RELAY_DEMO_CODE: CODE })).toBeNull();
    expect(demoPairingCode({ CEZ_RELAY_DEMO_CODE: CODE, CEZ_DRY_RUN: '0' })).toBeNull();
    expect(demoPairingCode({ CEZ_RELAY_DEMO_CODE: 'too-short', CEZ_DRY_RUN: '1' })).toBeNull();
    expect(demoPairingCode({ CEZ_RELAY_DEMO_CODE: CODE, CEZ_DRY_RUN: '1' })).toBe('DEM07K2P9QXA');
    const plain = await make({ CEZ_RELAY_DEMO_CODE: CODE });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(plain.list().pairing).toBeNull();
    await expect(new PhoneSim(relay.open).pairWithCode(ORIGIN, CODE)).rejects.toThrow(/no-rendezvous/);
  });

  it('keeps the code open and approves a phone with nobody at the computer', async () => {
    const demo = await make({ CEZ_RELAY_DEMO_CODE: CODE, CEZ_DRY_RUN: '1' });
    await until(() => open(demo));
    const phone = new PhoneSim(relay.open);
    await phone.pairWithCode(ORIGIN, CODE.toLowerCase());
    expect(await phone.outcome()).toEqual({ t: 'approved' });
    await until(() => demo.list().phones.length === 1);
    expect(relay.allowlist.has(phone.deviceId)).toBe(true);
  });

  it('reopens the code within a second of an unused one expiring', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const settle = async (check: () => boolean, tick = 1) => {
        // PBKDF2 runs on the real thread pool: bound by real time, not by fake ticks.
        const end = performance.now() + 5_000;
        while (!check() && performance.now() < end) {
          if (tick) await vi.advanceTimersByTimeAsync(tick);
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(check()).toBe(true);
      };
      const demo = await make({ CEZ_RELAY_DEMO_CODE: CODE, CEZ_DRY_RUN: '1' });
      await settle(() => open(demo));
      const first = demo.list().pairing!.id;
      await vi.advanceTimersByTimeAsync(PAIRING_LIFE_MS);
      // Reopened within the next second, not after the 7 s an outcome needs.
      await vi.advanceTimersByTimeAsync(600);
      await settle(() => open(demo) && demo.list().pairing?.id !== first, 0);
    } finally {
      vi.useRealTimers();
    }
    const phone = new PhoneSim(relay.open);
    await phone.pairWithCode(ORIGIN, CODE);
    expect(await phone.outcome()).toEqual({ t: 'approved' });
  });
});

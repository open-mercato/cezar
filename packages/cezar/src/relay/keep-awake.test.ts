import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay, startWithAccount } from './fake-relay.testkit.ts';
import { KeepAwake, RelayPreferences, type KeepAwakeChild } from './keep-awake.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { RelayService } from './service.ts';

const ORIGIN = 'https://relay.example.test';

/** A fake `caffeinate`: records each start and kill, and can exit on its own. */
class FakeSpawn {
  children: { pid: number; killed: boolean; exit(error?: Error): void }[] = [];
  missing = false;
  spawn = (pid: number): KeepAwakeChild | null => {
    if (this.missing) return null;
    let listener: (error?: Error) => void = () => {};
    const child = { pid, killed: false, exit: (error?: Error) => listener(error) };
    this.children.push(child);
    return { kill: () => { child.killed = true; }, onExit: (fn) => { listener = fn; } };
  };
  get running() { return this.children.filter((child) => !child.killed).length; }
}

describe('KeepAwake', () => {
  const make = (fake: FakeSpawn, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) =>
    new KeepAwake({ spawn: fake.spawn, pid: 4242, platform: options.platform ?? 'darwin', env: options.env ?? {} });

  it('holds one caffeinate for this process while wanted, and lets go when not', () => {
    const fake = new FakeSpawn();
    const keep = make(fake);
    keep.update(true);
    keep.update(true);
    expect(fake.children).toEqual([expect.objectContaining({ pid: 4242, killed: false })]);
    expect(keep.active).toBe(true);
    keep.update(false);
    expect(fake.children[0]!.killed).toBe(true);
    expect(keep.active).toBe(false);
    keep.update(true);
    expect(fake.children).toHaveLength(2);
    keep.release();
    expect(fake.running).toBe(0);
  });

  it.each([
    [{ CEZ_RELAY_KEEP_AWAKE: '0' }, 'darwin', 'switched-off'],
    [{ CEZ_DRY_RUN: '1' }, 'darwin', 'dry-run'],
    [{}, 'linux', 'not-macos'],
  ] as const)('never starts with %o on %s', (env, platform, reason) => {
    const fake = new FakeSpawn();
    const keep = make(fake, { env, platform });
    keep.update(true);
    expect(fake.children).toHaveLength(0);
    expect(keep.unavailable).toBe(reason);
  });

  it('a missing caffeinate degrades quietly, and is not tried again', () => {
    const fake = new FakeSpawn();
    fake.missing = true;
    const keep = make(fake);
    expect(() => keep.update(true)).not.toThrow();
    expect(keep.unavailable).toBe('missing');
    fake.missing = false;
    keep.update(true);
    expect(fake.children).toHaveLength(0);
  });

  it('an ENOENT after spawn marks it missing and says so', () => {
    const fake = new FakeSpawn();
    let changes = 0;
    const keep = make(fake);
    keep.onChange = () => { changes += 1; };
    keep.update(true);
    fake.children[0]!.exit(Object.assign(new Error('spawn caffeinate ENOENT'), { code: 'ENOENT' }));
    expect(keep.active).toBe(false);
    expect(keep.unavailable).toBe('missing');
    expect(changes).toBe(1);
  });

  it('a caffeinate that exits on its own is started again at the next change', () => {
    const fake = new FakeSpawn();
    const keep = make(fake);
    keep.update(true);
    fake.children[0]!.exit();
    expect(keep.active).toBe(false);
    keep.update(true);
    expect(fake.children).toHaveLength(2);
  });
});

describe('RelayPreferences', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'cez-relay-prefs-')); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('is on by default, remembers off, and a corrupt file is the default', () => {
    expect(new RelayPreferences(directory).keepAwake).toBe(true);
    new RelayPreferences(directory).setKeepAwake(false);
    expect(new RelayPreferences(directory).keepAwake).toBe(false);
    writeFileSync(join(directory, 'settings.json'), '{nope');
    expect(new RelayPreferences(directory).keepAwake).toBe(true);
  });
});

describe('RelayService keeps the computer awake only while a phone is paired', () => {
  let directory: string;
  let relay: FakeRelay;
  let fake: FakeSpawn;
  let service: RelayService;
  const make = () => {
    const created = new RelayService({
      directory,
      env: { CEZ_RELAY_URL: ORIGIN },
      open: relay.open,
      accountPost: relay.accounts.post,
      label: 'Test Mac',
      keepAwake: new KeepAwake({ spawn: fake.spawn, platform: 'darwin', env: {} }),
    });
    created.attach(async () => new Response('ok'), () => {});
    return created;
  };
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(condition()).toBe(true);
  };
  const pair = async () => {
    const started = await startWithAccount(service);
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await waitFor(() => service.list().pairing?.status === 'confirm');
    service.approvePairing(started.id);
    await phone.outcome();
    await waitFor(() => service.list().pairing?.status === 'approved');
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-relay-awake-'));
    relay = new FakeRelay();
    fake = new FakeSpawn();
    service = make();
  });
  afterEach(() => {
    service.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it('none before pairing; held once paired; released by the toggle, a removal and dispose', async () => {
    expect(service.list().keepAwake).toEqual({ enabled: true, active: false });
    await pair();
    expect(fake.running).toBe(1);
    expect(service.list().keepAwake).toEqual({ enabled: true, active: true });

    expect(service.setKeepAwake(false)).toEqual({ enabled: false, active: false });
    expect(fake.running).toBe(0);
    expect(new RelayPreferences(directory).keepAwake).toBe(false);
    service.setKeepAwake(true);
    expect(fake.running).toBe(1);

    service.remove(service.list().phones[0]!.deviceId);
    expect(fake.running).toBe(0);
    service.setKeepAwake(true);
    expect(fake.running).toBe(0);
  });

  it('a restart with a phone paired holds it at start, and dispose lets go', async () => {
    await pair();
    service.dispose();
    expect(fake.running).toBe(0);
    service = make();
    await service.start();
    expect(fake.running).toBe(1);
    service.dispose();
    expect(fake.running).toBe(0);
  });

  it('a switched-off choice survives a restart', async () => {
    await pair();
    service.setKeepAwake(false);
    service.dispose();
    service = make();
    await service.start();
    expect(fake.running).toBe(0);
    expect(service.list().keepAwake).toEqual({ enabled: false, active: false });
  });
});

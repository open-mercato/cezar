import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelay } from './fake-relay.testkit.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { probeRelay } from './probe.ts';
import { RelayIdentityStore } from './identity.ts';
import { RelayAddressError, RelayService, type RelayAddressStore } from './service.ts';
import type { SocketFactory, SocketHandlers } from './socket.ts';
import { CLOSE, DEFAULT_RELAY_ORIGIN, parseRelayOrigin, resolveRelayAddress } from './wire.ts';

const OLD = 'https://old.example.test';
const NEW = 'https://new.example.test';

const waitFor = async (check: () => boolean, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('resolveRelayAddress', () => {
  const saved = NEW;

  it('blocks, then the environment, then the saved address', () => {
    expect(resolveRelayAddress({ CEZ_RELAY: '0', CEZ_RELAY_URL: OLD }, saved)).toEqual({ origin: null, source: 'none' });
    expect(resolveRelayAddress({ CEZ_RELAY_URL: OLD }, saved)).toEqual({ origin: OLD, source: 'env' });
    expect(resolveRelayAddress({}, saved)).toEqual({ origin: NEW, source: 'settings' });
  });

  it('a set but invalid CEZ_RELAY_URL wins, so nothing falls through to another relay', () => {
    expect(resolveRelayAddress({ CEZ_RELAY_URL: 'http://relay.example.test' }, saved)).toEqual({ origin: null, source: 'env-invalid' });
  });

  it('an empty CEZ_RELAY_URL is unset', () => {
    expect(resolveRelayAddress({ CEZ_RELAY_URL: '' }, saved).source).toBe('settings');
  });

  it('unset means the default, a bad saved value is ignored, and the default itself is valid', () => {
    expect(parseRelayOrigin(DEFAULT_RELAY_ORIGIN)).toBe(DEFAULT_RELAY_ORIGIN);
    expect(resolveRelayAddress({}, null)).toEqual({ origin: DEFAULT_RELAY_ORIGIN, source: 'default' });
    expect(resolveRelayAddress({}, undefined)).toEqual({ origin: DEFAULT_RELAY_ORIGIN, source: 'default' });
    expect(resolveRelayAddress({}, 'http://relay.example.test')).toEqual({ origin: DEFAULT_RELAY_ORIGIN, source: 'default' });
  });
});

describe('changing the relay address', () => {
  let directory: string;
  let old: FakeRelay;
  let next: FakeRelay;
  let store: RelayAddressStore & { value: string | null };
  let services: RelayService[];
  const open: SocketFactory = (url, headers, handlers) => (url.includes('old.example') ? old : next).open(url, headers, handlers);

  const keys = () => new RelayIdentityStore(directory, async () => null);
  const make = (env: NodeJS.ProcessEnv = {}) => {
    const service = new RelayService({ directory, env, open, label: 'Test Mac', addressStore: store, identity: keys() });
    service.attach(async () => new Response('ok'), () => {});
    services.push(service);
    return service;
  };
  const pairOne = async (service: RelayService): Promise<PhoneSim> => {
    const started = await service.startPairing();
    const phone = new PhoneSim(open);
    await phone.pairWithQr(started.qr);
    await waitFor(() => service.list().pairing?.status === 'confirm');
    service.approvePairing(started.id);
    await phone.outcome();
    await waitFor(() => service.list().pairing?.status === 'approved');
    return phone;
  };
  const devicesFile = () => JSON.parse(readFileSync(join(directory, 'devices.json'), 'utf8')) as { devices: unknown[]; pendingRemovals: unknown[] };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-relay-address-'));
    old = new FakeRelay();
    next = new FakeRelay();
    services = [];
    store = {
      value: OLD,
      read: async () => store.value,
      write: async (address) => { store.value = address; },
    };
  });

  afterEach(() => {
    for (const service of services) service.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it('nothing contacts a relay on boot, a list or a save with no phone paired', async () => {
    const service = make();
    await service.start();
    service.list();
    await service.setAddress(NEW, false);
    await service.start();
    expect(old.opened).toEqual([]);
    expect(next.opened).toEqual([]);
    expect(existsSync(join(directory, '.key'))).toBe(false);
  });

  it('a restart keeps it, and the next pairing uses it with no restart', async () => {
    const service = make();
    await service.setAddress(NEW, false);
    expect(store.value).toBe(NEW);
    const started = await service.startPairing();
    expect(started.relayOrigin).toBe(NEW);
    expect(started.qr.startsWith(`${NEW}/p#1.`)).toBe(true);
    const restarted = make();
    await restarted.start();
    expect(restarted.list()).toMatchObject({ relayOrigin: NEW, relaySource: 'settings' });
  });

  it('refuses with phones paired until the user has answered, and changes nothing', async () => {
    const service = make();
    await pairOne(service);
    await expect(service.setAddress(NEW, false)).rejects.toMatchObject({ status: 409 });
    expect(store.value).toBe(OLD);
    expect(service.list().phones).toHaveLength(1);
    expect(old.cezarConnected).toBe(true);
  });

  it.each([['changing', NEW], ['clearing', null]])('%s: rows go, the phone hears it, the old socket closes, the identity stays', async (_name, address) => {
    const service = make();
    const phone = await pairOne(service);
    await phone.connect();
    await waitFor(() => service.list().phones[0]?.connected === true, 'session');
    const { deviceId } = phone;
    const identity = await keys().load();

    await service.setAddress(address, true);

    expect(service.list().phones).toEqual([]);
    expect(devicesFile()).toMatchObject({ devices: [], pendingRemovals: [] });
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'close'), 'CLOSE in the tunnel');
    expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.deviceRemoved });
    await waitFor(() => phone.closes.includes(4403), '4403 from the old relay');
    expect(old.allowlist.has(deviceId)).toBe(false);
    expect(old.cezarConnected).toBe(false);
    expect(service.list().relay.status).toBe('off');
    expect(next.opened).toEqual([]);
    const after = await keys().load();
    expect(after?.cezarId).toBe(identity?.cezarId);
    expect(after?.x25519Public.equals(identity!.x25519Public)).toBe(true);
    expect(store.value).toBe(address);
  });

  it('the same phone can pair again through the new relay, under the same identity', async () => {
    const service = make();
    const first = await service.startPairing();
    const cezarKey = first.qr.split('.').pop();
    const phone = new PhoneSim(open);
    await phone.pairWithQr(first.qr);
    await waitFor(() => service.list().pairing?.status === 'confirm');
    service.approvePairing(first.id);
    await phone.outcome();
    await waitFor(() => service.list().pairing?.status === 'approved');
    await service.setAddress(NEW, true);
    const again = await pairOne(service);
    expect(service.list().phones).toHaveLength(1);
    expect(next.allowlist.has(again.deviceId)).toBe(true);
    const third = await service.startPairing();
    expect(third.qr.split('.').pop()).toBe(cezarKey);
  });

  it('a queued removal stays with the old relay, so the new one never hears of that phone', async () => {
    const service = make();
    const phone = await pairOne(service);
    old.commands['device-remove'] = 'silent';
    service.remove(phone.deviceId);
    await waitFor(() => devicesFile().pendingRemovals.length === 1, 'queued removal');
    await service.setAddress(NEW, false);
    expect(devicesFile().pendingRemovals).toEqual([]);
    await make().start();
    expect(next.opened).toEqual([]);
  }, 8_000);

  it('a dead old relay cannot hold the save', async () => {
    const service = make();
    await pairOne(service);
    old.commands['device-remove'] = 'silent';
    const before = Date.now();
    await service.setAddress(NEW, true);
    expect(Date.now() - before).toBeLessThan(6_500);
    expect(store.value).toBe(NEW);
    expect(old.cezarConnected).toBe(false);
  }, 8_000);

  it('a live pairing on the old relay is cancelled, and one awaiting a decision blocks the change', async () => {
    const service = make();
    const started = await service.startPairing();
    await service.setAddress(NEW, false);
    expect(service.list().pairing).toMatchObject({ id: started.id, status: 'cancelled' });
    await service.setAddress(OLD, false);

    const pending = await service.startPairing();
    const phone = new PhoneSim(open);
    await phone.pairWithQr(pending.qr);
    await waitFor(() => service.list().pairing?.status === 'confirm');
    await expect(service.setAddress(NEW, false)).rejects.toThrow('waiting for your answer');
    expect(store.value).toBe(OLD);
  });

  it('a failed save leaves the address, and with no phones costs nothing', async () => {
    const service = make();
    store.write = async () => { throw new Error('read-only'); };
    await expect(service.setAddress(NEW, false)).rejects.toBeInstanceOf(RelayAddressError);
    expect(service.list().relayOrigin).toBe(OLD);
  });

  it('another cezar on this home moving the address closes this one\'s socket, and it cannot restore the rows', async () => {
    const service = make();
    const phone = await pairOne(service);
    await make().setAddress(NEW, true);
    expect(service.list().phones).toEqual([]);
    expect(service.rename(phone.deviceId, 'x')).toBe(false);
    expect(devicesFile().devices).toEqual([]);
    await service.refreshAddress();
    expect(old.cezarConnected).toBe(false);
    expect(service.list()).toMatchObject({ relayOrigin: NEW, relay: { status: 'off' } });
    expect(next.opened).toEqual([]);
  });

  it('a failed read leaves the socket of a paired phone alone', async () => {
    const service = make();
    await pairOne(service);
    store.read = async () => { throw new Error('unreadable'); };
    await service.refreshAddress();
    expect(old.cezarConnected).toBe(true);
    expect(service.list().phones).toHaveLength(1);
  });

  it('a hand edit closes the socket and says so, and never lists a phone to the new relay', async () => {
    const service = make();
    await pairOne(service);
    store.value = NEW;
    await service.refreshAddress();
    expect(old.cezarConnected).toBe(false);
    expect(service.list().relay.status).toBe('error');
    expect(service.list().phones).toHaveLength(1);
    expect(next.opened).toEqual([]);
  });

  it('a phone paired after another cezar moved the address never reaches the old relay', async () => {
    const stale = make();
    await pairOne(stale);
    const other = make();
    await other.setAddress(NEW, true);
    const phone = await pairOne(other);
    await stale.refreshAddress();
    expect(old.cezarConnected).toBe(false);
    expect(old.allowlist.has(phone.deviceId)).toBe(false);
    expect(next.allowlist.has(phone.deviceId)).toBe(true);
  });

  it('pairing after a hand edit adds the phone on the relay in its QR code', async () => {
    const service = make();
    await pairOne(service);
    store.value = NEW;
    const phone = await pairOne(service);
    expect(next.allowlist.has(phone.deviceId)).toBe(true);
    expect(old.allowlist.has(phone.deviceId)).toBe(false);
  });

  it('with nothing set it pairs through the default, out of the box', async () => {
    store.value = null;
    const service = make();
    expect(service.list()).toMatchObject({ relaySource: 'default' });
    const started = await service.startPairing();
    expect(started.relayOrigin).toBe(DEFAULT_RELAY_ORIGIN);
    expect(started.qr.startsWith(`${DEFAULT_RELAY_ORIGIN}/p#1.`)).toBe(true);
  });

  it('Use default and naming the default both store nothing, so a later default reaches this user', async () => {
    const service = make();
    await service.setAddress(null, false);
    expect(store.value).toBeNull();
    await service.setAddress(NEW, false);
    await service.setAddress(DEFAULT_RELAY_ORIGIN, false);
    expect(store.value).toBeNull();
    expect(service.list()).toMatchObject({ relayOrigin: DEFAULT_RELAY_ORIGIN, relaySource: 'default' });
  });

  it('Use default on the default changes nothing, and keeps the phones', async () => {
    store.value = null;
    const service = make();
    await pairOne(service);
    await service.setAddress(null, false);
    expect(service.list().phones).toHaveLength(1);
    expect(next.cezarConnected).toBe(true);
  });

  it('a pairing whose keychain prompt outlasts a save does not open on the relay it left', async () => {
    let held = false;
    let release = () => {};
    const slow = keys();
    const ensure = slow.ensure.bind(slow);
    slow.ensure = async () => { await new Promise<void>((resolve) => { release = resolve; held = true; }); return ensure(); };
    const service = new RelayService({ directory, env: {}, open, addressStore: store, identity: slow });
    services.push(service);
    const starting = service.startPairing();
    await waitFor(() => held, 'the keychain wait');
    await service.setAddress(NEW, false);
    release();
    await expect(starting).rejects.toThrow('address changed');
    expect(old.opened).toEqual([]);
  });

  it('a boot whose keychain prompt outlasts a save opens no socket', async () => {
    await pairOne(make());
    let held = false;
    let release = () => {};
    const slow = keys();
    const load = slow.load.bind(slow);
    slow.load = async () => { await new Promise<void>((resolve) => { release = resolve; held = true; }); return load(); };
    const service = new RelayService({ directory, env: {}, open, addressStore: store, identity: slow });
    services.push(service);
    const opened = old.opened.length;
    const starting = service.start();
    await waitFor(() => held, 'the keychain wait');
    await service.setAddress(NEW, true);
    release();
    await starting;
    expect(old.opened.length).toBe(opened);
    expect(next.opened).toEqual([]);
  });

  it('two saves at once: one wins, one is refused', async () => {
    const service = make();
    await pairOne(service);
    const results = await Promise.allSettled([service.setAddress(NEW, true), service.setAddress(null, true)]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.value).toBe(NEW);
  });

  it('CEZ_RELAY_URL owns it, valid or not', async () => {
    await expect(make({ CEZ_RELAY_URL: NEW }).setAddress(null, true)).rejects.toThrow('CEZ_RELAY_URL');
    await expect(make({ CEZ_RELAY_URL: 'nonsense' }).setAddress(NEW, true)).rejects.toThrow('CEZ_RELAY_URL');
    expect(store.value).toBe(OLD);
  });

  describe('Test', () => {
    it('reads the protocol, saves nothing and creates no identity', async () => {
      const service = make();
      expect(await service.testAddress(NEW)).toEqual({ ok: true, origin: NEW, protocol: 1 });
      expect(next.opened).toHaveLength(1);
      expect(next.opened[0]).toMatch(/\/v1\/pair\/[A-Za-z0-9_-]{43}\?role=cezar$/);
      expect(store.value).toBe(OLD);
      expect(existsSync(join(directory, '.key'))).toBe(false);
      expect(existsSync(join(directory, 'devices.json'))).toBe(false);
    });

    it('never proves with this computer\'s key', async () => {
      await make().startPairing();
      const seen: Record<string, string>[] = [];
      const spy: SocketFactory = (url, headers, handlers) => { seen.push(headers); return next.open(url, headers, handlers); };
      const probing = new RelayService({ directory, env: {}, open: spy, addressStore: store, identity: keys() });
      await probing.testAddress(NEW);
      await probing.testAddress(NEW);
      probing.dispose();
      const identity = await keys().load();
      expect(seen[0]?.['X-Cezar-Relay-Key']).toBeTruthy();
      expect(seen[0]?.['X-Cezar-Relay-Key']).not.toBe(identity?.edPublic.toString('base64url'));
      // One key per process, so repeated checks are one first-seen id to `newRoomsPerHour`.
      expect(seen[1]?.['X-Cezar-Relay-Key']).toBe(seen[0]?.['X-Cezar-Relay-Key']);
    });

    it('refuses an invalid address without opening anything', async () => {
      expect(await make().testAddress('http://new.example.test')).toEqual({ ok: false, reason: 'invalid-address' });
      expect(next.opened).toEqual([]);
    });

    const scripted = (script: (handlers: SocketHandlers) => void): { open: SocketFactory; closed: number[] } => {
      const closed: number[] = [];
      return {
        closed,
        open: (_url, _headers, handlers) => {
          queueMicrotask(() => script(handlers));
          return { send: () => {}, close: (code) => { closed.push(code); }, terminate: () => { closed.push(1006); } };
        },
      };
    };
    const seed = Buffer.alloc(32, 7);

    it.each([
      [{ status: 0 }, 'unreachable'],
      [{ status: 502 }, 'unreachable'],
      [{ status: 503 }, 'unreachable'],
      [{ status: 503, code: 'relay-disabled' }, 'disabled'],
      [{ status: 426, code: 'protocol-unsupported' }, 'incompatible'],
      [{ status: 429, code: 'rate-limited' }, 'rate-limited'],
      [{ status: 401, code: 'bad-proof' }, 'refused'],
      [{ status: 200 }, 'not-a-relay'],
      [{ status: 404 }, 'not-a-relay'],
    ])('refusal %j reads as %s', async (refusal, reason) => {
      expect(await probeRelay(NEW, scripted((handlers) => handlers.onRefused(refusal)).open, seed)).toEqual({ ok: false, reason });
    });

    it.each([
      ['another protocol', JSON.stringify({ t: 'hello', protocol: 2 }), 'incompatible'],
      ['an unusable frame size', JSON.stringify({ t: 'hello', protocol: 1, limits: { frameBytes: 100 } }), 'incompatible'],
      ['not JSON', 'welcome', 'not-a-relay'],
      ['another first frame', JSON.stringify({ t: 'other' }), 'not-a-relay'],
      ['binary', Buffer.from([1, 2]), 'not-a-relay'],
    ])('%s fails and closes', async (_name, frame, reason) => {
      const socket = scripted((handlers) => { handlers.onOpen(); handlers.onMessage(frame); });
      expect(await probeRelay(NEW, socket.open, seed)).toEqual({ ok: false, reason });
      expect(socket.closed).toEqual([1000]);
    });

    it('a socket that closes unopened is unreachable, opened is not a relay, 4426 is incompatible', async () => {
      expect(await probeRelay(NEW, scripted((handlers) => handlers.onClose(1006)).open, seed)).toEqual({ ok: false, reason: 'unreachable' });
      expect(await probeRelay(NEW, scripted((handlers) => { handlers.onOpen(); handlers.onClose(1000); }).open, seed)).toEqual({ ok: false, reason: 'not-a-relay' });
      expect(await probeRelay(NEW, scripted((handlers) => { handlers.onOpen(); handlers.onClose(4426); }).open, seed)).toEqual({ ok: false, reason: 'incompatible' });
    });
  });
});

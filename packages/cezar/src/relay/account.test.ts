import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_TERMS } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_RETRY_JITTER_MS, ACCOUNT_RETRY_MS, RelayConnection } from './connection.ts';
import { RelayDevices } from './devices.ts';
import { seal, unseal } from './account.ts';
import { FakeRelay } from './fake-relay.testkit.ts';
import { RelayIdentityStore } from './identity.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { RelayService } from './service.ts';

/** RELAY_PROTOCOL.md § 18, every state the Settings screen and a phone can meet. */

const ORIGIN = 'https://relay.example.test';
const EMAIL = 'me@example.test';
const HOURS_48 = 48 * 3600;

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error(`timed out waiting for ${what}`);
};

describe('relay accounts', () => {
  let directory: string;
  let relay: FakeRelay;
  const services: RelayService[] = [];

  const make = () => {
    const service = new RelayService({ directory, env: { CEZ_RELAY_URL: ORIGIN }, open: relay.open, label: 'Test Mac', accountPost: relay.accounts.post });
    service.attach(async () => new Response('ok'), () => {});
    services.push(service);
    return service;
  };
  const cezarId = async () => (await new RelayIdentityStore(directory).load())!.cezarId;
  const pair = async (service: RelayService): Promise<PhoneSim> => {
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until(() => service.list().pairing?.status === 'confirm', 'confirm');
    service.approvePairing(started.id);
    await phone.outcome();
    await until(() => service.list().pairing?.status === 'approved', 'approved');
    return phone;
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-relay-account-'));
    relay = new FakeRelay();
    relay.enforceAccounts = true;
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it('a new user: no code before an email and accepted terms, and nothing is asked of the relay before that', async () => {
    const service = make();
    expect(service.list().account).toEqual({ attached: false });
    expect(await service.accountStatus()).toEqual({ local: { attached: false }, status: null });
    expect(relay.accounts.calls).toEqual([]);
    await expect(service.startPairing()).rejects.toThrow('Enter your email and accept the Terms and Privacy Policy first.');
    expect(relay.opened).toEqual([]);

    const attached = await service.setAccount(EMAIL, RELAY_TERMS.version);
    expect(attached).toMatchObject({ local: { attached: true, email: EMAIL, termsVersion: RELAY_TERMS.version }, linkSent: true, status: { state: 'pending' } });
    expect(relay.accounts.calls[0]).toEqual({ path: '/v1/accounts', body: { email: EMAIL, termsVersion: RELAY_TERMS.version, accepted: true } });

    const phone = await pair(service);
    expect(relay.accounts.devices.get(await cezarId())).toEqual([phone.deviceId]);
  });

  it('keeps the token sealed on disk and sends it on the socket', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    const token = `tok.${await cezarId()}.1`;
    const file = readFileSync(join(directory, 'account.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain(EMAIL);
    await pair(service);
    expect(relay.cezarHeaders['X-Cezar-Relay-Account']).toBe(token);
  });

  it('seal and unseal round-trip, and another key opens nothing', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = seal(key, 'tok.abc');
    expect(unseal(key, sealed)).toBe('tok.abc');
    expect(unseal(Buffer.alloc(32, 8), sealed)).toBeNull();
    expect(unseal(key, 'garbage')).toBeNull();
  });

  it('pending: the status carries the time left, and the emailed link confirms it, seen by Check now', async () => {
    let now = Date.now();
    const service = new RelayService({ directory, env: { CEZ_RELAY_URL: ORIGIN }, open: relay.open, accountPost: relay.accounts.post, now: () => now });
    services.push(service);
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    const pending = await service.accountStatus();
    expect(pending.status).toMatchObject({ state: 'pending', email: EMAIL });
    expect(pending.status!.secondsLeft).toBeGreaterThan(HOURS_48 - 60);
    relay.accounts.followLink(await cezarId());
    now += 10_000;
    expect((await service.accountStatus()).status?.state).toBe('pending'); // A poll inside the minute is the cached answer.
    expect((await service.accountStatus(true)).status).toMatchObject({ state: 'confirmed', graceEndsAt: null, secondsLeft: null });
  });

  it('Check now asks the relay at most every 10 s', async () => {
    let now = Date.now();
    const service = new RelayService({ directory, env: { CEZ_RELAY_URL: ORIGIN }, open: relay.open, accountPost: relay.accounts.post, now: () => now });
    services.push(service);
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    const statusCalls = () => relay.accounts.calls.filter((call) => call.path === '/v1/accounts/status').length;
    await service.accountStatus(true);
    await service.accountStatus(true);
    expect(statusCalls()).toBe(1);
    now += 10_000;
    await service.accountStatus(true);
    expect(statusCalls()).toBe(2);
  });

  it('confirmed: resend is refused as already confirmed', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    relay.accounts.followLink(await cezarId());
    await expect(service.resendAccountLink()).rejects.toMatchObject({ code: 'already-confirmed' });
    expect((await service.accountStatus()).status?.state).toBe('confirmed');
  });

  it('missing terms: the relay refuses the rendezvous with 451, and Settings says what to do', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    relay.accounts.attachments.clear(); // The relay forgot the attachment; cezar still holds a token.
    await expect(service.startPairing()).rejects.toThrow('needs your email and accepted terms');
  });

  it('missing terms on device-add fails the pairing as terms-required, and no row stays', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    const started = await service.startPairing();
    relay.accounts.attachments.clear();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until(() => service.list().pairing?.status === 'confirm', 'confirm');
    service.approvePairing(started.id);
    await until(() => service.list().pairing?.status === 'failed', 'failed');
    expect(service.list().pairing?.failure).toBe('terms-required');
    expect(service.list().phones).toEqual([]);
  });

  it('an existing pairing is asked once, keeps working in the grace, and is refused only after it', async () => {
    relay.enforceAccounts = false; // Paired before accounts existed.
    const first = make();
    relay.enforceAccounts = false;
    const unsupported = relay.accounts.unsupported;
    relay.accounts.unsupported = true;
    await first.setAccount(EMAIL, RELAY_TERMS.version); // `no-route`: an old relay needs none.
    relay.accounts.unsupported = unsupported;
    await pair(first);
    first.dispose();

    // The update: accounts are on, nothing was attached, phones are paired.
    relay.enforceAccounts = true;
    const booted = make();
    await booted.start();
    expect(booted.list().account).toEqual({ attached: false, prompt: true });
    await until(() => booted.list().relay.status === 'connected', 'connected inside the grace');

    booted.dismissAccountPrompt();
    expect(booted.list().account).toEqual({ attached: false });
    expect(make().list().account).toEqual({ attached: false }); // Once, across restarts.

    relay.accounts.age(await cezarId(), HOURS_48 + 1);
    relay.closeCezar(1001);
    await until(() => booted.list().relay.status === 'account-required', 'refused after the grace');
    expect(booted.list().phones).toHaveLength(1);
  });

  it('blocked then confirmed: the socket comes back with no re-pair', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    const phone = await pair(service);
    const id = await cezarId();
    relay.accounts.age(id, HOURS_48 + 1);
    expect((await service.accountStatus()).status?.state).toBe('blocked');
    relay.closeCezar(1001);
    await until(() => service.list().relay.status === 'email-unconfirmed', 'blocked');

    await service.resendAccountLink();
    relay.accounts.followLink(id);
    await service.accountStatus(true);
    await until(() => service.list().relay.status === 'connected', 'reconnected at once on a confirmed status');
    expect(service.list().phones.map((row) => row.deviceId)).toEqual([phone.deviceId]);
    expect(relay.allowlist.has(phone.deviceId)).toBe(true);
  });

  it('expired grace with an account but no confirmation: the socket gets email-unconfirmed, and pairing a new phone still needs confirmation only at the relay', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    await pair(service);
    relay.accounts.age(await cezarId(), HOURS_48 + 1);
    relay.closeCezar(1001);
    await until(() => service.list().relay.status === 'email-unconfirmed', 'blocked');
    expect(service.list().account.attached).toBe(true);
  });

  it('changing the email attaches again, and a stale token is dropped on bad-token', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    await service.setAccount('other@example.test', RELAY_TERMS.version);
    expect(service.list().account.email).toBe('other@example.test');
    relay.accounts.attachments.get(await cezarId())!.epoch += 1; // Attached elsewhere.
    await expect(service.resendAccountLink()).rejects.toMatchObject({ code: 'bad-token' });
    expect(service.list().account.attached).toBe(false);
  });

  it('a relay pinned to newer terms answers terms-outdated', async () => {
    relay.accounts.termsVersion = '2099-01-01';
    const service = make();
    await expect(service.setAccount(EMAIL, RELAY_TERMS.version)).rejects.toMatchObject({ code: 'terms-outdated', status: 409 });
    expect(service.list().account.attached).toBe(false);
  });

  it('a relay without accounts lets pairing start', async () => {
    relay.enforceAccounts = false;
    relay.accounts.unsupported = true;
    const service = make();
    expect(await service.setAccount(EMAIL, RELAY_TERMS.version)).toMatchObject({ status: null, problem: 'unsupported' });
    await expect(service.startPairing()).resolves.toMatchObject({ relayOrigin: ORIGIN });
  });

  it('takes the reason from the close frame when no error frame came', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    await pair(service);
    relay.accounts.attachments.get(await cezarId())!.account = undefined;
    relay.accounts.age(await cezarId(), HOURS_48 + 1);
    relay.reasonInCloseOnly = true;
    relay.closeCezar(1001);
    await until(() => service.list().relay.status === 'account-required', 'account-required from the close reason');
  });

  it('polls the relay for status at most once a minute, and an action asks again', async () => {
    const service = make();
    await service.setAccount(EMAIL, RELAY_TERMS.version);
    const statusCalls = () => relay.accounts.calls.filter((call) => call.path === '/v1/accounts/status').length;
    await service.accountStatus();
    await service.accountStatus();
    expect(statusCalls()).toBe(1);
    await service.resendAccountLink();
    await service.accountStatus();
    expect(statusCalls()).toBe(2);
  });

  it('a device-sync refused for terms is sent again without the new devices', async () => {
    relay.enforceAccounts = false;
    relay.accounts.unsupported = true;
    const first = make();
    await first.setAccount(EMAIL, RELAY_TERMS.version);
    const phone = await pair(first);
    first.dispose();
    // A row the relay never saw, as after a lost device-add.
    new RelayDevices(directory).add({ deviceId: 'A'.repeat(22), label: 'Lost', platform: 'android', relayKey: 'B'.repeat(43), noiseKey: 'C'.repeat(43), addedAt: '', grants: [] });
    relay.accounts.unsupported = false;
    relay.enforceAccounts = true;
    const booted = make();
    await booted.start();
    await until(() => relay.cezarFrames.filter((frame) => typeof frame === 'string' && frame.includes('device-sync')).length >= 2, 'the second sync');
    expect(relay.allowlist.has(phone.deviceId)).toBe(true);
    expect(relay.allowlist.has('A'.repeat(22))).toBe(false);
  });
});

describe('the 4451 retry (§ 18)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits a fixed 10 minutes plus up to 60 s, with no growing backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const relay = new FakeRelay();
    relay.enforceAccounts = true;
    const identity = (await import('./identity.ts')).identityFromRoot(Buffer.alloc(32, 9));
    relay.accounts.age(identity.cezarId, HOURS_48 + 1);
    const statuses: string[] = [];
    const connection = new RelayConnection({
      origin: ORIGIN, identity, open: relay.open, random: () => 1,
      syncDevices: () => [], onUp: () => {}, onDown: () => {}, onPhoneJoined: () => {}, onPhoneLeft: () => {}, onData: () => {},
      onStatus: (status) => statuses.push(status),
    });
    connection.start();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(relay.opened.length).toBe(attempt);
      await vi.advanceTimersByTimeAsync(ACCOUNT_RETRY_MS + ACCOUNT_RETRY_JITTER_MS - 1);
      expect(relay.opened.length).toBe(attempt);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(statuses).toContain('account-required');
    connection.retryNow();
    connection.stop();
  });
});

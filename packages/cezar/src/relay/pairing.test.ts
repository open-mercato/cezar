import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRelay } from './fake-relay.testkit.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { RelayService, PairingStartError, PAIRINGS_PER_HOUR } from './service.ts';
import { PAIRING_LIFE_MS } from './pairing.ts';

const ORIGIN = 'https://relay.example.test';

describe('pairing', () => {
  let directory: string;
  let relay: FakeRelay;
  let service: RelayService;
  let changes: number;

  const make = (env: NodeJS.ProcessEnv = { CEZ_RELAY_URL: ORIGIN }) => {
    const created = new RelayService({ directory, env, open: relay.open, label: 'Test Mac' });
    created.attach(async () => new Response('ok'), () => { changes += 1; });
    return created;
  };
  const devicesFile = () => join(directory, 'devices.json');
  const settle = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const status = () => service.list().pairing?.status;
  const until = async (want: string) => {
    for (let i = 0; i < 400 && status() !== want; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(status()).toBe(want);
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-relay-pairing-'));
    relay = new FakeRelay();
    changes = 0;
    service = make();
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it('pairs by QR: both sides show one number, and a row appears only on Approve', async () => {
    const started = await service.startPairing();
    expect(started.qr.startsWith(`${ORIGIN}/p#1.`)).toBe(true);
    const phone = new PhoneSim(relay.open);
    const { digits, pending } = await phone.pairWithQr(started.qr);
    await until('confirm');
    const view = service.list().pairing!;
    expect(view).toMatchObject({ method: 'qr', digits, phone: { name: 'Sim phone', platform: 'android' } });
    expect(pending).toMatchObject({ t: 'pending', label: 'Test Mac', tunnel: { min: 1, max: 1 } });
    expect(service.list().phones).toEqual([]);
    expect(existsSync(devicesFile())).toBe(false);
    expect(relay.cezarConnected).toBe(false);

    expect(service.approvePairing(started.id)).toBe(true);
    expect(await phone.outcome()).toEqual({ t: 'approved' });
    await until('approved');
    expect(service.list().phones).toMatchObject([{ deviceId: phone.deviceId, label: 'Sim phone', platform: 'android', connected: false }]);
    expect(relay.allowlist.has(phone.deviceId)).toBe(true);
    const commands = relay.cezarFrames.filter((f): f is string => typeof f === 'string' && f !== 'ping').map((f) => (JSON.parse(f) as { t: string }).t);
    expect(commands).toEqual(['device-sync', 'device-add']);
  });

  it('pairs by typed code, in the same flow', async () => {
    const started = await service.startPairing();
    expect(started.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const phone = new PhoneSim(relay.open);
    const { digits } = await phone.pairWithCode(started.relayOrigin, started.code!.toLowerCase());
    await until('confirm');
    expect(service.list().pairing).toMatchObject({ method: 'code', digits });
    service.approvePairing(started.id);
    expect(await phone.outcome()).toEqual({ t: 'approved' });
  });

  it('closes the other rendezvous when a phone joins one', async () => {
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    const late = new PhoneSim(relay.open);
    await expect(late.pairWithCode(started.relayOrigin, started.code!)).rejects.toThrow(/no-rendezvous/);
  });

  it('Deny discards everything', async () => {
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until('confirm');
    expect(service.denyPairing(started.id)).toBe(true);
    expect(await phone.outcome()).toEqual({ t: 'denied' });
    expect(status()).toBe('denied');
    expect(service.list().phones).toEqual([]);
    expect(existsSync(devicesFile())).toBe(false);
  });

  it('a closed screen cancels: nothing remains and the code is dead', async () => {
    const started = await service.startPairing();
    service.denyPairing(started.id);
    expect(status()).toBe('cancelled');
    await settle();
    await expect(new PhoneSim(relay.open).pairWithQr(started.qr)).rejects.toThrow(/no-rendezvous/);
  });

  it('expires after two minutes and offers nothing usable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const started = await service.startPairing();
    await vi.advanceTimersByTimeAsync(PAIRING_LIFE_MS - 1);
    expect(status()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(status()).toBe('expired');
    vi.useRealTimers();
    await settle();
    await expect(new PhoneSim(relay.open).pairWithQr(started.qr)).rejects.toThrow(/no-rendezvous/);
  });

  it('is single use', async () => {
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until('confirm');
    service.approvePairing(started.id);
    await phone.outcome();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(new PhoneSim(relay.open).pairWithQr(started.qr)).rejects.toThrow();
  });

  it('a contested join ends the pairing and warns', async () => {
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until('confirm');
    await expect(new PhoneSim(relay.open).pairWithQr(started.qr)).rejects.toThrow(/pair-taken/);
    await until('failed');
    expect(service.list().pairing?.failure).toBe('contested');
    expect(service.approvePairing(started.id)).toBe(false);
    expect(service.list().phones).toEqual([]);
  });

  it('a phone that pins another key never sends its identity', async () => {
    const started = await service.startPairing();
    const swapped = started.qr.replace(/\.[^.]+$/, `.${Buffer.alloc(32, 7).toString('base64url')}`);
    await expect(new PhoneSim(relay.open).pairWithQr(swapped)).rejects.toThrow('pin mismatch');
    await settle();
    expect(service.list().pairing?.phone).toBeUndefined();
  });

  it('refuses a sixth pairing in an hour, and the relay is not asked', async () => {
    for (let i = 0; i < PAIRINGS_PER_HOUR; i += 1) await service.startPairing();
    const opened = relay.opened.length;
    await expect(service.startPairing()).rejects.toBeInstanceOf(PairingStartError);
    expect(relay.opened.length).toBe(opened);
  });

  it('refuses a new code while a phone waits for an answer', async () => {
    const started = await service.startPairing();
    await new PhoneSim(relay.open).pairWithQr(started.qr);
    await until('confirm');
    await expect(service.startPairing()).rejects.toThrow(/waiting for your answer/);
  });

  it('with no ack it deletes the row and both sides hear it failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    relay.commands['device-add'] = 'silent';
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    const pairing = phone.pairWithQr(started.qr);
    await vi.advanceTimersByTimeAsync(50);
    await pairing;
    await vi.advanceTimersByTimeAsync(50);
    service.approvePairing(started.id);
    const outcome = phone.outcome(20_000);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await outcome).toEqual({ t: 'failure', reason: 'relay-error' });
    expect(service.list().pairing).toMatchObject({ status: 'failed', failure: 'relay-error' });
    expect(service.list().phones).toEqual([]);
  });

  it('names a full list', async () => {
    relay.commands['device-add'] = 'device-limit';
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until('confirm');
    service.approvePairing(started.id);
    expect(await phone.outcome()).toEqual({ t: 'failure', reason: 'device-limit' });
    expect(service.list().phones).toEqual([]);
  });

  it('shows the QR code alone when the second rendezvous is refused', async () => {
    let seen = 0;
    relay.refuse = (url) => (url.includes('/v1/pair/') && (seen += 1) === 2 ? { status: 429, retryAfter: 3600 } : undefined);
    const started = await service.startPairing();
    expect(started.code).toBeNull();
    expect(started.qr).toContain('/p#1.');
  });

  it('never lets the code or secret reach an event, a log or a file', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    }
    const views: string[] = [];
    service.attach(async () => new Response('ok'), () => { views.push(JSON.stringify(service.list())); });
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await until('confirm');
    service.approvePairing(started.id);
    await phone.outcome();
    await until('approved');
    vi.restoreAllMocks();
    const secret = started.qr.split('#1.')[1]!.split('.')[0]!;
    const code = started.code!;
    const files = readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8'));
    for (const haystack of [...lines, ...views, ...files]) {
      expect(haystack).not.toContain(secret);
      expect(haystack).not.toContain(code);
      expect(haystack).not.toContain(code.replaceAll('-', ''));
    }
    expect(views.length).toBeGreaterThan(0);
  });

  it('CEZ_RELAY=0 blocks a pairing and any socket', async () => {
    service.dispose();
    service = make({ CEZ_RELAY_URL: ORIGIN, CEZ_RELAY: '0' });
    await expect(service.startPairing()).rejects.toBeInstanceOf(PairingStartError);
    await service.start();
    expect(relay.opened).toEqual([]);
  });

  it('counts changes for the event bus', async () => {
    await service.startPairing();
    expect(changes).toBeGreaterThan(0);
  });
});

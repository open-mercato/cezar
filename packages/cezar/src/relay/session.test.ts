import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayConnection, backoffMs, limitsFrom } from './connection.ts';
import { RelayDevices } from './devices.ts';
import { FakeRelay } from './fake-relay.testkit.ts';
import { identityFromRoot } from './identity.ts';
import { PhoneSim } from './phone-sim.testkit.ts';
import { RelayService, removalFrames } from './service.ts';
import { LEASE_TIMEOUT_MS, MAX_STREAMS } from './session.ts';
import type { RelaySocket, SocketHandlers } from './socket.ts';
import { CLOSE, RESET, type TunnelFrame } from './wire.ts';

const ORIGIN = 'https://relay.example.test';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function waitFor(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out: ${label}`);
}

describe('sessions and the tunnel', () => {
  let directory: string;
  let relay: FakeRelay;
  let service: RelayService;
  let requests: Request[];
  let responder: (request: Request) => Response | Promise<Response>;

  const make = () => {
    const created = new RelayService({ directory, env: { CEZ_RELAY_URL: ORIGIN }, open: relay.open, label: 'Test Mac' });
    created.attach(async (request) => {
      requests.push(request);
      return responder(request);
    }, () => {});
    return created;
  };

  const paired = async (): Promise<PhoneSim> => {
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await waitFor(() => service.list().pairing?.status === 'confirm');
    service.approvePairing(started.id);
    await phone.outcome();
    await waitFor(() => service.list().pairing?.status === 'approved');
    return phone;
  };
  const session = async (): Promise<PhoneSim> => {
    const phone = await paired();
    await phone.connect();
    await waitFor(() => phone.leases > 0, 'first LEASE echo');
    return phone;
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-relay-session-'));
    relay = new FakeRelay();
    requests = [];
    responder = () => new Response('hello');
    service = make();
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it('carries a GET and a POST body, and drops every header the proxy drops', async () => {
    const phone = await session();
    responder = async (request) => new Response(`${request.method} ${await request.text()}`, { status: 201, headers: { 'x-echo': 'yes', connection: 'close' } });
    const forged: [string, string][] = [
      ['host', '127.0.0.1:4321'], ['origin', 'http://127.0.0.1:4321'], ['cookie', 'a=b'], ['authorization', 'Basic x'],
      ['x-forwarded-for', '127.0.0.1'], ['x-forwarded-host', 'localhost'], ['forwarded', 'for=127.0.0.1'], ['x-real-ip', '127.0.0.1'],
      ['sec-fetch-site', 'same-origin'], ['keep-alive', 'x'], ['te', 'trailers'], ['content-type', 'text/plain'],
    ];
    const answer = await phone.fetch('POST', '/api/v1/echo?x=1', forged, 'the body');
    expect(answer.status).toBe(201);
    expect(answer.body.toString()).toBe('POST the body');
    expect(answer.headers.find(([name]) => name === 'connection')).toBeUndefined();
    expect(answer.headers).toContainEqual(['x-echo', 'yes']);
    const seen = requests[0]!;
    expect(new URL(seen.url).pathname + new URL(seen.url).search).toBe('/api/v1/echo?x=1');
    expect(seen.headers.get('host')).toBe('relay.invalid');
    for (const name of ['origin', 'cookie', 'authorization', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'sec-fetch-site', 'keep-alive', 'te']) {
      expect(seen.headers.get(name), name).toBeNull();
    }
    expect(seen.headers.get('content-type')).toBe('text/plain');
  });

  it('refuses Upgrade, so no WebSocket crosses the tunnel', async () => {
    const phone = await session();
    await expect(phone.fetch('GET', '/api/v1/ws', [['upgrade', 'websocket']])).rejects.toThrow(`reset ${RESET.badRequest}`);
    expect(requests).toEqual([]);
  });

  it('a content-length that does not match is RESET bad-request', async () => {
    const phone = await session();
    responder = async (request) => new Response(await request.text());
    await expect(phone.fetch('POST', '/x', [['content-length', '3']], 'too long')).rejects.toThrow(`reset ${RESET.badRequest}`);
  });

  it('a 204 is HEAD then END', async () => {
    const phone = await session();
    responder = () => new Response(null, { status: 204 });
    const answer = await phone.fetch('DELETE', '/x');
    expect(answer.status).toBe(204);
    expect(answer.body.length).toBe(0);
  });

  it('streams SSE as it is written, and a reset cancels the producer', async () => {
    const phone = await session();
    let cancelled = false;
    let push!: (text: string) => void;
    responder = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { push = (text) => controller.enqueue(new TextEncoder().encode(text)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const stream = phone.stream('GET', '/events');
    expect((await stream.head).status).toBe(200);
    push('event: one\n\n');
    expect(await stream.next()).toBe('event: one\n\n');
    push('event: two\n\n');
    expect(await stream.next()).toBe('event: two\n\n');
    stream.reset();
    await waitFor(() => cancelled, 'producer cancelled');
  });

  it('flow control holds a stalled reader to 256 KiB, then resumes on WINDOW', async () => {
    const phone = await session();
    const size = 400_000;
    responder = () => new Response(new Uint8Array(size));
    // A raw OPEN with nobody acknowledging: the sim's automatic WINDOW is bypassed.
    phone.frame({ type: 'open', stream: 1, method: 'GET', target: '/big', headers: [] });
    phone.frame({ type: 'end', stream: 1 });
    const payload = () => phone.tunnelFrames.flatMap((frame) => (frame.type === 'data' ? [frame.data.length] : [])).reduce((a, b) => a + b, 0);
    await waitFor(() => payload() === 262_144, 'window filled');
    await tick();
    expect(payload()).toBe(262_144);
    phone.frame({ type: 'window', stream: 1, increment: 262_144 });
    await waitFor(() => payload() === size, 'rest of the body');
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'end'), 'END');
  });

  it('answers a stream over the 32 with too-many-streams and keeps the session', async () => {
    const phone = await session();
    responder = () => new Response(new ReadableStream({ start() {} }));
    const open = Array.from({ length: MAX_STREAMS }, () => phone.stream('GET', '/hold'));
    await Promise.all(open.map((stream) => stream.head));
    await expect(phone.fetch('GET', '/extra')).rejects.toThrow(`reset ${RESET.tooManyStreams}`);
    open[0]!.reset();
    await tick();
    responder = () => new Response('ok');
    expect((await phone.fetch('GET', '/after')).body.toString()).toBe('ok');
  });

  it.each<[string, (phone: PhoneSim) => void]>([
    ['a skipped stream id', (phone) => phone.frame({ type: 'open', stream: 9, method: 'GET', target: '/', headers: [] })],
    ['a frame for a stream nobody opened', (phone) => phone.frame({ type: 'end', stream: 5 })],
    ['a HEAD from the phone', (phone) => phone.frame({ type: 'head', stream: 1, status: 200, headers: [] })],
    ['a tampered ciphertext', (phone) => phone.raw(Buffer.alloc(304, 1))],
  ])('%s ends the session with protocol-error', async (_name, act) => {
    const phone = await session();
    act(phone);
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'close'), 'CLOSE');
    expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.protocolError });
    await waitFor(() => !service.list().phones[0]!.connected, 'session ended');
  });

  it('refuses a first message that is not exactly 48 bytes, and answers nothing', async () => {
    const phone = await paired();
    const before = relay.cezarFrames.length;
    await phone.connect().then(() => phone.closeSocket());
    await waitFor(() => !service.list().phones[0]!.connected);
    const count = relay.cezarFrames.length;
    expect(count).toBeGreaterThan(before);
    // A fresh slot, and a first message carrying a payload.
    relay.control({ t: 'phone-joined', device: phone.deviceId });
    relay.inject(phone.deviceId, Buffer.alloc(60, 1));
    relay.inject(phone.deviceId, Buffer.alloc(48, 1));
    await tick();
    expect(relay.cezarFrames.length).toBe(count);
  });

  it('an OPEN it would refuse still ends a session that has not leased', async () => {
    const phone = await paired();
    await phone.connect([{ type: 'hello', min: 1, max: 1 }, { type: 'open', stream: 1, method: 'TRACE', target: '/', headers: [] }]);
    await waitFor(() => phone.tunnelFrames.length > 0, 'an answer');
    expect(phone.tunnelFrames).toEqual([{ type: 'close', code: CLOSE.protocolError }]);
  });

  it('a stale frame on an open slot does not use it up', async () => {
    const phone = await paired();
    const count = relay.cezarFrames.length;
    relay.control({ t: 'phone-joined', device: phone.deviceId });
    relay.inject(phone.deviceId, Buffer.alloc(304, 1));
    relay.inject(phone.deviceId, Buffer.alloc(48, 1));
    await tick();
    expect(relay.cezarFrames.length).toBe(count);
    await phone.connect();
    await waitFor(() => phone.leases > 0, 'session after stale frames');
  });

  it('answers one first message per slot', async () => {
    const phone = await session();
    const first = phone.lastFirstMessage!;
    // The session ended and the slot stayed used, so the same bytes get no second reply.
    phone.frame({ type: 'close', code: CLOSE.normal });
    await waitFor(() => !service.list().phones[0]!.connected);
    const count = relay.cezarFrames.length;
    relay.inject(phone.deviceId, first);
    await tick();
    expect(relay.cezarFrames.length).toBe(count);
  });

  it('coalesces a burst into far fewer DATA frames, and paces them', async () => {
    const phone = await session();
    const events = 5_000;
    responder = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < events; i += 1) controller.enqueue(new TextEncoder().encode(`event: run\ndata: ${i}\n\n`));
        controller.close();
      },
    }));
    const before = phone.tunnelFrames.length;
    const answer = await phone.fetch('GET', '/replay');
    expect(answer.body.toString().match(/event: run/g)).toHaveLength(events);
    const frames = phone.tunnelFrames.slice(before).filter((frame) => frame.type === 'data');
    expect(frames.length).toBeLessThan(events / 50);
  });

  it('paces DATA at 40% of framesPerSecond across every stream', async () => {
    const phone = await session();
    relay.hello = {};
    responder = () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setImmediate(resolve));
        controller.enqueue(new Uint8Array(10));
      },
    }));
    const stream = phone.stream('GET', '/firehose');
    await stream.head;
    const count = () => phone.tunnelFrames.filter((frame) => frame.type === 'data').length;
    const before = count();
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rate = (count() - before) / ((Date.now() - started) / 1000);
    stream.reset();
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThanOrEqual(220);
  });

  it('paces HEAD and END with DATA, because a first load is mostly small responses', async () => {
    const phone = await session();
    const responses = 30;
    const started = Date.now();
    await Promise.all(Array.from({ length: responses }, (_, index) => phone.fetch('GET', `/chunk-${index}.js`)));
    const frames = responses * 3;
    expect(frames / ((Date.now() - started) / 1000)).toBeLessThanOrEqual(220);
  });

  it('drops x-cezar-runtime-handoff', async () => {
    const phone = await session();
    await phone.fetch('GET', '/x', [['x-cezar-runtime-handoff', 'token']]);
    expect(requests[0]!.headers.get('x-cezar-runtime-handoff')).toBeNull();
  });

  it('drops a device with no row without a reply', async () => {
    await paired();
    const stranger = new PhoneSim(relay.open);
    const count = relay.cezarFrames.length;
    relay.control({ t: 'phone-joined', device: stranger.deviceId });
    relay.inject(stranger.deviceId, Buffer.alloc(48, 2));
    await tick();
    expect(relay.cezarFrames.length).toBe(count);
  });

  it('Remove: row first, CLOSE device-removed, streams end, then device-remove', async () => {
    const phone = await session();
    let cancelled = false;
    responder = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const stream = phone.stream('GET', '/events');
    await stream.head;
    expect(service.remove(phone.deviceId)).toBe(true);
    expect(service.list().phones).toEqual([]);
    await waitFor(() => cancelled, 'stream cancelled');
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'close'));
    expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.deviceRemoved });
    await waitFor(() => phone.closes.includes(4403), '4403');
    await waitFor(() => !relay.cezarConnected, 'last Remove closes the socket');
    expect(service.list().relay.status).toBe('off');
    const removed = relay.cezarFrames.filter((f): f is string => typeof f === 'string' && f.includes('device-remove'));
    expect(removed).toHaveLength(1);
    await expect(phone.connect()).rejects.toThrow(/device-removed/);
  });

  it('a rolled-back pairing ends the session it let up, whatever the relay does', async () => {
    relay.swallowRemovals = true;
    relay.commands['device-add'] = 'silent';
    const started = await service.startPairing();
    const phone = new PhoneSim(relay.open);
    await phone.pairWithQr(started.qr);
    await waitFor(() => service.list().pairing?.status === 'confirm');
    service.approvePairing(started.id);
    const add = () => relay.cezarFrames.find((f): f is string => typeof f === 'string' && f.includes('device-add'));
    await waitFor(() => add() !== undefined, 'device-add');
    await phone.connect();
    await waitFor(() => phone.leases > 0, 'LEASE echo');

    relay.control({ t: 'error', id: (JSON.parse(add()!) as { id: string }).id, code: 'internal' });
    await waitFor(() => service.list().pairing?.status === 'failed');
    expect(service.list().phones).toEqual([]);
    expect(service.remove(phone.deviceId)).toBe(false);
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'close'), 'CLOSE');
    expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.deviceRemoved });
    phone.stream('GET', '/api/v1/workspace');
    await tick();
    expect(requests).toEqual([]);
  });

  it('a replayed first message shows nobody connected and leaves "seen" alone', async () => {
    const phone = await session();
    const before = service.list().phones[0]!;
    expect(before).toMatchObject({ connected: true });
    const first = phone.lastFirstMessage!;
    phone.closeSocket();
    await waitFor(() => !service.list().phones[0]!.connected);
    const seen = service.list().phones[0]!.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const count = relay.cezarFrames.length;
    relay.control({ t: 'phone-joined', device: phone.deviceId });
    relay.inject(phone.deviceId, first);
    await waitFor(() => relay.cezarFrames.length > count, 'KK reply');
    await tick();
    expect(service.list().phones[0]).toMatchObject({ connected: false, lastSeenAt: seen });
    relay.control({ t: 'phone-left', device: phone.deviceId });
    await tick();
    expect(service.list().phones[0]!.lastSeenAt).toBe(seen);
  });

  it('counts a phone as connected from its first HELLO', async () => {
    const phone = await paired();
    expect(service.list().phones[0]).not.toHaveProperty('lastSeenAt');
    await phone.connect();
    await waitFor(() => service.list().phones[0]!.connected);
    expect(service.list().phones[0]!.lastSeenAt).toBeTruthy();
  });

  it('a HELLO with min over max is a protocol error, not a version mismatch', async () => {
    const phone = await paired();
    await phone.connect([{ type: 'hello', min: 2, max: 1 }, { type: 'lease' }]);
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'close'));
    expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.protocolError });
  });

  it('DATA after a GET has sent END is a protocol error', async () => {
    const phone = await session();
    const stream = phone.stream('GET', '/slow');
    phone.frame({ type: 'data', stream: stream.id, data: Buffer.from('late') });
    await waitFor(() => phone.tunnelFrames.some((frame) => frame.type === 'close'));
    expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.protocolError });
  });

  it('a handler that stops reading a body does not cost the session', async () => {
    const phone = await session();
    responder = async (request) => {
      await request.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('early');
    };
    const body = 'x'.repeat(1_000);
    const answer = await phone.fetch('POST', '/api/v1/runs', [['content-length', '1000']], body);
    expect(answer.status).toBe(200);
    expect(phone.tunnelFrames.some((frame) => frame.type === 'close')).toBe(false);
  });

  it('a lost device-remove is sent again after the next connect', async () => {
    const phone = await paired();
    const other = await paired();
    relay.commands['device-remove'] = 'silent';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    service.remove(phone.deviceId);
    await vi.advanceTimersByTimeAsync(10_001);
    vi.useRealTimers();
    relay.commands['device-remove'] = 'ack';
    const before = relay.cezarFrames.filter((f) => typeof f === 'string' && f.includes('device-remove')).length;
    relay.closeCezar(1001);
    await waitFor(() => relay.cezarFrames.filter((f) => typeof f === 'string' && f.includes('device-remove')).length > before, 'resent');
    expect(service.list().phones.map((row) => row.deviceId)).toEqual([other.deviceId]);
  }, 15_000);

  it('goodbye deletes the row, then tells the relay', async () => {
    const phone = await session();
    phone.frame({ type: 'close', code: CLOSE.goodbye });
    await waitFor(() => service.list().phones.length === 0, 'row gone');
    await waitFor(() => relay.cezarFrames.some((f) => typeof f === 'string' && f.includes('device-remove')), 'device-remove');
  });

  it('a phone whose socket left ends its session, and a new socket gets a new KK', async () => {
    const phone = await session();
    phone.closeSocket();
    await waitFor(() => !service.list().phones[0]!.connected);
    await phone.connect();
    await waitFor(() => service.list().phones[0]!.connected);
    expect((await phone.fetch('GET', '/again')).body.toString()).toBe('hello');
  });

  it('rekeys the sending direction after an hour, keeping the session', async () => {
    const phone = await session();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_001);
    expect((await phone.fetch('GET', '/after-rekey')).body.toString()).toBe('hello');
    spy.mockRestore();
    expect(phone.tunnelFrames.some((frame) => frame.type === 'rekey')).toBe(true);
  });

  it('honours a REKEY from the phone', async () => {
    const phone = await session();
    phone.frame({ type: 'rekey' });
    (phone as unknown as { sender: { rekey(): void } }).sender.rekey();
    expect((await phone.fetch('GET', '/after')).status).toBe(200);
  });

  describe('sleep guards', () => {
    const allowedIdle = (frame: string | Buffer) => frame === 'ping';

    it('stream-origin: cezar emits nothing for a stream the phone did not open', async () => {
      const phone = await session();
      const streamed: TunnelFrame[] = phone.tunnelFrames.filter((frame) => 'stream' in frame);
      expect(streamed).toEqual([]);
      expect(phone.tunnelFrames.every((frame) => frame.type === 'lease')).toBe(true);
    });

    it('quiet: with no session, only ping and the one device-sync cross the socket', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, '.key'), Buffer.alloc(32, 9).toString('base64'));
      new RelayDevices(directory).add({ deviceId: 'dXtIS8djB99atVWpeg3BQw', label: 'x', platform: 'android', relayKey: 'A'.repeat(43), noiseKey: 'A'.repeat(43), addedAt: '', grants: [] });
      service = make();
      await service.start();
      await vi.advanceTimersByTimeAsync(10);
      const sync = relay.cezarFrames.splice(0);
      expect(sync).toHaveLength(1);
      expect(JSON.parse(sync[0] as string)).toMatchObject({ t: 'device-sync' });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(relay.cezarFrames.every(allowedIdle)).toBe(true);
      expect(relay.cezarFrames).toHaveLength(80);
    });

    it('lease: streams do not survive 60 s without LEASE', async () => {
      const phone = await session();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let cancelled = false;
      responder = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      phone.lease(); // Rearms the clock under the fake timer.
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      const stream = phone.stream('GET', '/events');
      await vi.advanceTimersByTimeAsync(1);
      await stream.head;
      await vi.advanceTimersByTimeAsync(LEASE_TIMEOUT_MS - 10);
      expect(cancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(11);
      expect(cancelled).toBe(true);
      expect(phone.tunnelFrames.find((frame) => frame.type === 'close')).toEqual({ type: 'close', code: CLOSE.leaseExpired });
      const frames = relay.cezarFrames.length;
      await vi.advanceTimersByTimeAsync(LEASE_TIMEOUT_MS);
      expect(relay.cezarFrames.length).toBe(frames);
    });

    it('LEASE renews, and is answered once each', async () => {
      const phone = await session();
      const before = phone.leases;
      phone.lease();
      await waitFor(() => phone.leases === before + 1);
    });
  });

  describe('empty input', () => {
    it('no devices means no socket', async () => {
      await service.start();
      expect(relay.opened).toEqual([]);
      expect(service.list()).toMatchObject({ relay: { status: 'off' }, phones: [], pairing: null });
    });

    it('a pending removal with no devices connects, sends an empty device-sync and closes', async () => {
      writeFileSync(join(directory, '.key'), Buffer.alloc(32, 9).toString('base64'));
      const devices = new RelayDevices(directory);
      devices.add({ deviceId: 'dXtIS8djB99atVWpeg3BQw', label: 'x', platform: 'android', relayKey: 'A'.repeat(43), noiseKey: 'A'.repeat(43), addedAt: '', grants: ['g1'] });
      devices.remove('dXtIS8djB99atVWpeg3BQw');
      service = make();
      await service.start();
      await waitFor(() => relay.cezarFrames.length >= 2);
      const frames = relay.cezarFrames.map((frame) => JSON.parse(frame as string) as Record<string, unknown>);
      expect(frames[0]).toMatchObject({ t: 'device-sync', devices: [] });
      expect(frames[1]).toMatchObject({ t: 'device-remove', grants: ['g1'] });
      await waitFor(() => !relay.cezarConnected);
    });

    it('absent hello limits fall back to the table', () => {
      expect(limitsFrom({})).toEqual({ frameBytes: 65_552, controlBytes: 8_192, devices: 10, framesPerSecond: 500 });
      expect(limitsFrom({ limits: { frameBytes: 20_000 } })).toMatchObject({ frameBytes: 20_000, controlBytes: 8_192 });
      expect(limitsFrom({ limits: { frameBytes: 'x', devices: -1 } })).toEqual({ frameBytes: 65_552, controlBytes: 8_192, devices: 10, framesPerSecond: 500 });
    });

    it('a corrupt devices.json degrades to empty, with one warning', () => {
      writeFileSync(join(directory, 'devices.json'), '{nope');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const devices = new RelayDevices(directory);
      expect(devices.list()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('one bad row never evicts the rest', () => {
      writeFileSync(join(directory, 'devices.json'), JSON.stringify({ devices: [{ deviceId: 'bad' }, { deviceId: 'dXtIS8djB99atVWpeg3BQw', platform: 'ios', relayKey: 'A'.repeat(43), noiseKey: 'A'.repeat(43) }] }));
      expect(new RelayDevices(directory).list().map((row) => row.platform)).toEqual(['ios']);
    });
  });
});

describe('removalFrames', () => {
  it('splits a list that does not fit controlBytes', () => {
    const grants = Array.from({ length: 400 }, (_, i) => `grant-${String(i).padStart(16, '0')}`);
    const frames = removalFrames({ deviceId: 'd'.repeat(22), grants }, 8_192);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.flatMap((frame) => frame.grants)).toEqual(grants);
    for (const frame of frames) expect(Buffer.byteLength(JSON.stringify({ ...frame, id: 'x'.repeat(64) }))).toBeLessThanOrEqual(8_192);
  });
});

describe('RelayConnection', () => {
  class Script {
    sockets: { handlers: SocketHandlers; sent: (string | Buffer)[]; closed?: number; socket: RelaySocket }[] = [];
    open = (_url: string, _headers: Record<string, string>, handlers: SocketHandlers): RelaySocket => {
      const entry = {
        handlers,
        sent: [] as (string | Buffer)[],
        closed: undefined as number | undefined,
        socket: {
          send: (data: string | Buffer) => { entry.sent.push(data); },
          close: (code: number) => { entry.closed = code; },
          terminate: () => handlers.onClose(1006),
        },
      };
      this.sockets.push(entry);
      return entry.socket;
    };
    get last() { return this.sockets[this.sockets.length - 1]!; }
    hello(extra: Record<string, unknown> = {}) { this.last.handlers.onMessage(JSON.stringify({ t: 'hello', protocol: 1, phones: [], ...extra })); }
  }
  const statuses: string[] = [];
  const connection = (script: Script) => new RelayConnection({
    origin: ORIGIN,
    identity: identityFromRoot(Buffer.alloc(32, 3)),
    open: script.open,
    random: () => 0.5,
    syncDevices: () => [],
    onUp: () => {},
    onDown: () => {},
    onPhoneJoined: () => {},
    onPhoneLeft: () => {},
    onData: () => {},
    onStatus: (status) => statuses.push(status),
  });

  beforeEach(() => {
    statuses.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends nothing until hello', () => {
    const script = new Script();
    connection(script).start();
    expect(script.last.sent).toEqual([]);
    script.hello();
    expect(script.last.sent).toHaveLength(1);
  });

  it('pings every 45 s, and no pong in 15 s counts as network loss', () => {
    const script = new Script();
    connection(script).start();
    script.hello();
    vi.advanceTimersByTime(45_000);
    expect(script.last.sent.at(-1)).toBe('ping');
    script.last.handlers.onMessage('pong');
    vi.advanceTimersByTime(45_000);
    vi.advanceTimersByTime(15_000);
    expect(statuses.at(-1)).toBe('unreachable');
  });

  it('reconnects with full jitter on 1001', () => {
    const script = new Script();
    connection(script).start();
    script.hello();
    script.last.handlers.onClose(1001);
    expect(script.sockets).toHaveLength(1);
    vi.advanceTimersByTime(backoffMs(1, () => 0.5));
    expect(script.sockets).toHaveLength(2);
  });

  it('caps the backoff at 300 s', () => {
    expect(backoffMs(20, () => 1)).toBe(300_000);
    expect(backoffMs(1, () => 0)).toBe(1_000);
  });

  it.each([[4409, 'replaced'], [4426, 'update-required'], [4400, 'error'], [4413, 'error']])('stops on %i', (code, status) => {
    const script = new Script();
    connection(script).start();
    script.hello();
    script.last.handlers.onClose(code);
    vi.advanceTimersByTime(3_600_000);
    expect(script.sockets).toHaveLength(1);
    expect(statuses.at(-1)).toBe(status);
  });

  it('keeps commands under the relay budget', async () => {
    const script = new Script();
    const relayed = connection(script);
    relayed.start();
    script.hello();
    for (let i = 0; i < 40; i += 1) void relayed.command({ t: 'device-remove', device: 'x' }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(script.last.sent.length).toBe(30);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(script.last.sent.length).toBeGreaterThan(30);
  });

  it('reconnects after retryAfter on 4429', () => {
    const script = new Script();
    connection(script).start();
    script.hello();
    script.last.handlers.onMessage(JSON.stringify({ t: 'closing', retryAfter: 90 }));
    script.last.handlers.onClose(4429);
    vi.advanceTimersByTime(89_999);
    expect(script.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(script.sockets).toHaveLength(2);
  });

  it('caps a retryAfter no timer can hold, instead of reconnecting at once', () => {
    const script = new Script();
    connection(script).start();
    script.hello();
    script.last.handlers.onMessage(JSON.stringify({ t: 'closing', retryAfter: 2 ** 31 }));
    script.last.handlers.onClose(4429);
    vi.advanceTimersByTime(86_399_000);
    expect(script.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(script.sockets).toHaveLength(2);
  });

  it('backs off 5 to 15 minutes on the kill switch', () => {
    const script = new Script();
    connection(script).start();
    script.last.handlers.onRefused({ status: 503, code: 'relay-disabled', retryAfter: 300 });
    vi.advanceTimersByTime(5 * 60_000);
    expect(script.sockets).toHaveLength(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(script.sockets).toHaveLength(2);
    expect(statuses).toContain('disabled');
  });

  it('corrects the clock from Date once, then stops on a second bad proof', () => {
    const script = new Script();
    connection(script).start();
    script.last.handlers.onRefused({ status: 401, code: 'bad-proof', date: new Date(Date.now() + 600_000).toUTCString() });
    vi.advanceTimersByTime(0);
    expect(script.sockets).toHaveLength(2);
    script.last.handlers.onRefused({ status: 401, code: 'bad-proof' });
    vi.advanceTimersByTime(3_600_000);
    expect(script.sockets).toHaveLength(2);
    expect(statuses.at(-1)).toBe('error');
  });

  it('treats another protocol as 4426', () => {
    const script = new Script();
    connection(script).start();
    script.hello({ protocol: 2 });
    expect(statuses.at(-1)).toBe('update-required');
    expect(script.last.closed).toBe(1000);
  });

  it('refuses a broken frameBytes', () => {
    const script = new Script();
    connection(script).start();
    script.hello({ limits: { frameBytes: 1_000 } });
    expect(statuses.at(-1)).toBe('error');
    expect(script.last.closed).toBe(1000);
  });
});

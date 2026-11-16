import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_RETRY_JITTER_MS, ACCOUNT_RETRY_MS, HELLO_WAIT_MS, PONG_WAIT_MS, REPLACED_RETRY_MS, RelayConnection, SERVICE_RESTART_JITTER_MS, SERVICE_RESTART_MIN_MS, WAKE_TICK_MS, backoffMs } from './connection.ts';
import { identityFromRoot } from './identity.ts';
import type { RelaySocket, SocketHandlers } from './socket.ts';

const ORIGIN = 'https://relay.example.test';
const IDENTITY = identityFromRoot(Buffer.alloc(32, 3));
const HALF = () => 0.5;

/** A fake socket factory. `silent`: `terminate()` emits nothing, as a half-open TCP socket can. */
class Script {
  sockets: { handlers: SocketHandlers; sent: (string | Buffer)[]; terminated: boolean }[] = [];
  constructor(private readonly silent = false) {}
  open = (_url: string, _headers: Record<string, string>, handlers: SocketHandlers): RelaySocket => {
    const entry = { handlers, sent: [] as (string | Buffer)[], terminated: false };
    this.sockets.push(entry);
    return {
      send: (data) => { entry.sent.push(data); },
      close: () => {},
      terminate: () => {
        entry.terminated = true;
        if (!this.silent) handlers.onClose(1006);
      },
    };
  };
  get last() { return this.sockets[this.sockets.length - 1]!; }
  hello() { this.last.handlers.onMessage(JSON.stringify({ t: 'hello', protocol: 1, phones: [] })); }
}

describe('RelayConnection recovery (Mac online, relay link lost)', () => {
  let statuses: { status: string; detail?: string }[];
  let lines: string[];
  let downs: number;
  const connect = (script: Script) => {
    const connection = new RelayConnection({
      origin: ORIGIN,
      identity: IDENTITY,
      open: script.open,
      random: HALF,
      syncDevices: () => [],
      onUp: () => {},
      onDown: () => { downs += 1; },
      onPhoneJoined: () => {},
      onPhoneLeft: () => {},
      onData: () => {},
      onStatus: (status, detail) => statuses.push({ status, ...(detail ? { detail } : {}) }),
      log: (line) => lines.push(line),
    });
    connection.start();
    return connection;
  };
  const last = () => statuses.at(-1)?.status;

  beforeEach(() => {
    statuses = [];
    lines = [];
    downs = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a socket that opens but never says hello is dropped and retried, not left connecting forever', () => {
    const script = new Script();
    connect(script);
    vi.advanceTimersByTime(HELLO_WAIT_MS);
    expect(script.sockets[0]!.terminated).toBe(true);
    expect(last()).toBe('unreachable');
    vi.advanceTimersByTime(backoffMs(1, HALF));
    expect(script.sockets).toHaveLength(2);
  });

  it('a silent stall (no close event, no pong) still reconnects', () => {
    const script = new Script(true);
    connect(script);
    script.hello();
    vi.advanceTimersByTime(45_000 + PONG_WAIT_MS);
    expect(script.sockets[0]!.terminated).toBe(true);
    expect(downs).toBe(1);
    expect(last()).toBe('unreachable');
    vi.advanceTimersByTime(backoffMs(1, HALF));
    expect(script.sockets).toHaveLength(2);
    script.hello();
    expect(last()).toBe('connected');
  });

  it('a dropped socket fails every command in flight at once', async () => {
    const script = new Script();
    const connection = connect(script);
    script.hello();
    const pending = connection.command({ t: 'device-add', device: 'x', key: 'y' }, 60_000);
    script.last.handlers.onClose(1006);
    await expect(pending).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('after a sleep, a backoff minutes out is cut short and retried at once', () => {
    const script = new Script();
    connect(script);
    for (let i = 0; i < 8; i += 1) {
      script.last.handlers.onClose(1006);
      vi.advanceTimersByTime(backoffMs(i + 1, HALF));
    }
    script.last.handlers.onClose(1006);
    const count = script.sockets.length;
    expect(backoffMs(9, HALF)).toBeGreaterThan(120_000);
    vi.setSystemTime(Date.now() + 30 * 60_000); // Timers froze while the lid was shut; the clock did not.
    vi.advanceTimersByTime(WAKE_TICK_MS);
    expect(script.sockets).toHaveLength(count + 1);
    expect(lines.some((line) => /wake gap=\d+s/.test(line))).toBe(true);
    script.hello();
    script.last.handlers.onClose(1006);
    expect(lines.at(-1)).toMatch(/attempt=1 /);
  });

  it('after a sleep, a live socket is probed at once instead of up to 45 s later', () => {
    const script = new Script(true);
    connect(script);
    script.hello();
    vi.advanceTimersByTime(25_000);
    expect(script.last.sent.filter((frame) => frame === 'ping')).toHaveLength(0);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    vi.advanceTimersByTime(5_000);
    expect(script.last.sent.at(-1)).toBe('ping');
    vi.advanceTimersByTime(PONG_WAIT_MS);
    expect(last()).toBe('unreachable');
  });

  it('a wake never cuts short a wait the relay asked for', () => {
    const script = new Script();
    connect(script);
    script.hello();
    script.last.handlers.onMessage(JSON.stringify({ t: 'closing', retryAfter: 600 }));
    script.last.handlers.onClose(4429);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    vi.advanceTimersByTime(WAKE_TICK_MS);
    expect(script.sockets).toHaveLength(1);
  });

  it.each([[200], [302], [401], [403], [404]])('a %i that the relay did not send (captive portal, proxy, CDN) is network loss', (status) => {
    const script = new Script();
    connect(script);
    script.last.handlers.onRefused({ status });
    expect(last()).toBe('unreachable');
    vi.advanceTimersByTime(backoffMs(1, HALF));
    expect(script.sockets).toHaveLength(2);
  });

  it.each([[undefined], ['account-unavailable']])('a 503 with code %s is backoff, not the 5-15 minute kill switch', (code) => {
    const script = new Script();
    connect(script);
    script.last.handlers.onRefused({ status: 503, ...(code ? { code } : {}) });
    expect(last()).toBe('unreachable');
    vi.advanceTimersByTime(backoffMs(1, HALF));
    expect(script.sockets).toHaveLength(2);
  });

  it('a relay that refuses with its own code still stops', () => {
    const script = new Script();
    connect(script);
    script.last.handlers.onRefused({ status: 404, code: 'no-route' });
    vi.advanceTimersByTime(3_600_000);
    expect(script.sockets).toHaveLength(1);
    expect(last()).toBe('error');
  });

  it('4409 replaced looks again later, slower each time, so an exited owner is not the end', () => {
    const script = new Script();
    connect(script);
    script.hello();
    script.last.handlers.onClose(4409);
    expect(last()).toBe('replaced');
    vi.advanceTimersByTime(REPLACED_RETRY_MS - 1);
    expect(script.sockets).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(script.sockets).toHaveLength(2);
    script.hello();
    script.last.handlers.onClose(4409);
    vi.advanceTimersByTime(2 * REPLACED_RETRY_MS - 1);
    expect(script.sockets).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(script.sockets).toHaveLength(3);
  });

  it('1012 reconnect (the relay operator asked) comes back within seconds, never as a failure', () => {
    const script = new Script();
    connect(script);
    for (let round = 1; round <= 5; round += 1) {
      script.hello();
      script.last.handlers.onClose(1012, 'reconnect');
      expect(last()).toBe('connecting');
      const before = script.sockets.length;
      vi.advanceTimersByTime(SERVICE_RESTART_MIN_MS + HALF() * SERVICE_RESTART_JITTER_MS - 1);
      expect(script.sockets).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(script.sockets).toHaveLength(before + 1);
    }
    expect(statuses.some((entry) => entry.status === 'unreachable' || entry.status === 'error')).toBe(false);
    // Not counted: the next real loss still starts at the first backoff step.
    script.hello();
    script.last.handlers.onClose(1006);
    const before = script.sockets.length;
    vi.advanceTimersByTime(backoffMs(1, HALF));
    expect(script.sockets).toHaveLength(before + 1);
  });

  it.each([[1012], [4409]])('a long uptime ended by %i clears the failure history', (code) => {
    const script = new Script();
    connect(script);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      script.last.handlers.onClose(1006);
      vi.advanceTimersByTime(backoffMs(attempt, HALF));
    }
    script.hello();
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    script.last.handlers.onClose(code, 'reconnect');
    const before = script.sockets.length;
    while (script.sockets.length === before) vi.advanceTimersByTime(1_000);
    script.hello();
    script.last.handlers.onClose(1006);
    expect(lines.at(-1)).toMatch(/attempt=1 /);
  });

  it('a reconnect storm stays on full-jitter backoff', () => {
    const script = new Script();
    connect(script);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      script.last.handlers.onClose(1006);
      const before = script.sockets.length;
      vi.advanceTimersByTime(backoffMs(attempt, HALF) - 1);
      expect(script.sockets).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(script.sockets).toHaveLength(before + 1);
    }
    expect(script.sockets.length).toBe(13);
  });

  it('diagnostics say when it connected, why it last went down, the attempt and the next try', () => {
    const script = new Script(true);
    const connection = connect(script);
    expect(connection.diagnostics()).toEqual({ stats: { since: new Date(Date.now()).toISOString(), relayedToday: 0, uptime: 0 } });
    script.hello();
    expect(connection.diagnostics().connectedAt).toBe(new Date(Date.now()).toISOString());
    vi.advanceTimersByTime(45_000 + PONG_WAIT_MS);
    const down = connection.diagnostics();
    expect(down.connectedAt).toBeUndefined();
    expect(down.lastDown).toEqual({ at: new Date(Date.now()).toISOString(), reason: 'no-pong' });
    expect(down.attempt).toBe(1);
    expect(down.nextRetryAt).toBe(new Date(Date.now() + backoffMs(1, HALF)).toISOString());
    vi.advanceTimersByTime(backoffMs(1, HALF));
    expect(connection.diagnostics().nextRetryAt).toBeUndefined();
  });

  it('stats count data frames both ways since local midnight and the share of time the socket was up', () => {
    vi.setSystemTime(new Date(2026, 10, 16, 23, 0, 0));
    const script = new Script(true);
    const connection = connect(script);
    vi.advanceTimersByTime(20_000);
    script.hello();
    const frame = Buffer.concat([Buffer.from([1]), Buffer.alloc(16, 7), Buffer.from('x')]);
    script.last.handlers.onMessage(frame);
    connection.sendData(Buffer.alloc(16, 7).toString('base64url'), Buffer.from('y'));
    expect(connection.diagnostics().stats).toMatchObject({ relayedToday: 2, uptime: 0 });
    vi.advanceTimersByTime(20_000);
    expect(connection.diagnostics().stats?.uptime).toBeCloseTo(0.5);
    vi.setSystemTime(new Date(2026, 10, 17, 0, 0, 1));
    expect(connection.diagnostics().stats?.relayedToday).toBe(0);
  });

  it('diagnostics keep the last 4451 reason and close code, and a relay reason never as free text', () => {
    const script = new Script();
    const connection = connect(script);
    script.hello();
    script.last.handlers.onMessage(JSON.stringify({ t: 'error', code: 'terms-required-device' }));
    script.last.handlers.onClose(4451);
    expect(connection.diagnostics().lastBlock?.reason).toBe('terms-required-device');
    expect(connection.diagnostics().lastDown).toMatchObject({ reason: 'terms-required-device', code: 4451 });
    vi.advanceTimersByTime(ACCOUNT_RETRY_MS + ACCOUNT_RETRY_JITTER_MS / 2);
    script.hello();
    script.last.handlers.onClose(1011, 'Something <b>odd</b> happened');
    expect(connection.diagnostics().lastDown).toMatchObject({ reason: 'other', code: 1011 });
    expect(connection.diagnostics().lastBlock?.reason).toBe('terms-required-device');
  });

  it('logs reasons, codes, timings and attempts, never an id, key or address', () => {
    const script = new Script();
    connect(script);
    script.hello();
    vi.advanceTimersByTime(45_000);
    script.last.handlers.onMessage('pong');
    vi.advanceTimersByTime(30_000);
    script.last.handlers.onClose(1006);
    expect(lines.at(-1)).toMatch(/^\[cezar\] relay: down reason=closed code=1006 up=75s attempt=1 retry=\d+s$/);
    expect(statuses.at(-1)?.detail).toMatch(/attempt 1, next try in \d+ s/);
    for (const line of lines) {
      expect(line).not.toContain(IDENTITY.cezarId);
      expect(line).not.toContain('relay.example.test');
    }
  });
});

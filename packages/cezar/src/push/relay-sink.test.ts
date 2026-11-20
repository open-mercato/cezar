import { randomBytes, verify, createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64u, edPublic, postProof } from '../relay/wire.ts';
import type { AttentionKind } from '@open-mercato/cezar-contract';
import { COUNT_DEBOUNCE_MS, COUNT_MIN_INTERVAL_MS, PUSH_DEBOUNCE_MS, PUSH_MIN_INTERVAL_MS, RelayPushSink, badgeCount, pushBody, quietUntil, type PushGrantRow } from './relay-sink.ts';

const ORIGIN = 'https://relay.example.test';
const SEED = randomBytes(32);
const GRANT = 'sealed-grant';
const GRANT_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_793_491_200_000;

interface Sent { url: string; headers: Record<string, string>; body: string }

function setup(over: {
  devices?: PushGrantRow[]; live?: string[]; streams?: string[]; status?: number; enabled?: boolean;
  count?: (kinds: readonly AttentionKind[]) => Promise<number>;
  answer?: (body: Record<string, unknown>) => { status: number; retryAfter?: number };
  warn?: (line: string) => void;
} = {}) {
  let now = NOW;
  const sent: Sent[] = [];
  const dropped: string[] = [];
  const delivered: Array<[string, string | undefined]> = [];
  const devices: PushGrantRow[] = over.devices ?? [{ deviceId: 'phone-a', push: { grant: GRANT, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 }, acceptsCount: true }];
  const sink = new RelayPushSink({
    enabled: () => over.enabled ?? true,
    origin: () => ORIGIN,
    seed: async () => SEED,
    devices: () => devices,
    live: (id) => (over.live ?? []).includes(id),
    deliver: (id, managerId) => {
      if (!(over.streams ?? []).includes(id)) return false;
      delivered.push([id, managerId]);
      return true;
    },
    hasStreams: () => (over.streams ?? []).length > 0,
    dropGrant: (id, grantId) => { dropped.push(`${id}:${grantId}`); },
    count: over.count ?? (async () => 3),
    post: async (url, { headers, body }) => {
      const text = Buffer.from(body).toString('utf8');
      sent.push({ url, headers, body: text });
      return over.answer?.(JSON.parse(text) as Record<string, unknown>) ?? { status: over.status ?? 202 };
    },
    ...(over.warn ? { warn: over.warn } : {}),
    now: () => now,
  });
  const advance = async (ms: number) => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await sink.idle();
  };
  return { sink, sent, dropped, delivered, advance };
}

describe('RelayPushSink', () => {
  afterEach(() => vi.useRealTimers());

  it('sends exactly the six protocol fields, with no text from the signal', async () => {
    vi.useFakeTimers();
    const { sink, sent, advance } = setup();
    sink.signal('manager-with-a-secret-name');
    await advance(PUSH_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['count', 'grant', 'id', 'kind', 'ts', 'v']);
    expect(body).toMatchObject({ v: 1, grant: GRANT, kind: 'attention', count: 3, ts: (NOW + PUSH_DEBOUNCE_MS) / 1000 });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sent[0]!.body).not.toContain('manager-with-a-secret-name');
    expect(sent[0]!.url).toBe(`${ORIGIN}/v1/push`);
  });

  it('signs the exact bytes with the cezar key, § 3.1', async () => {
    vi.useFakeTimers();
    const { sink, sent, advance } = setup();
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    const { headers, body } = sent[0]!;
    expect(headers['X-Cezar-Relay-Key']).toBe(b64u(edPublic(SEED)));
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), edPublic(SEED)]), format: 'der', type: 'spki' });
    const proof = postProof('/v1/push', Buffer.from(body, 'utf8'), Number(headers['X-Cezar-Relay-Time']));
    expect(verify(null, Buffer.from(proof), key, Buffer.from(headers['X-Cezar-Relay-Sig']!, 'base64url'))).toBe(true);
  });

  it('coalesces a burst into one push and keeps at most one a minute', async () => {
    vi.useFakeTimers();
    const { sink, sent, advance } = setup();
    sink.signal('a');
    sink.signal('b');
    sink.signal('c');
    await advance(PUSH_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    expect(sink.latestManager()).toBe('c');
    sink.signal('d');
    await advance(PUSH_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    await advance(PUSH_MIN_INTERVAL_MS - PUSH_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
  });

  it('skips a phone with a live session: it is already looking', async () => {
    vi.useFakeTimers();
    const { sink, sent, advance } = setup({ live: ['phone-a'] });
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    expect(sent).toHaveLength(0);
  });

  it('stage 1: a live phone with a signal stream gets the signal there and never a push', async () => {
    vi.useFakeTimers();
    const { sink, sent, delivered, advance } = setup({ live: ['phone-a'], streams: ['phone-a'] });
    sink.signal('m1');
    await advance(PUSH_DEBOUNCE_MS);
    expect(delivered).toEqual([['phone-a', 'm1']]);
    expect(sent).toHaveLength(0);
    sink.signal('m2');
    await advance(PUSH_DEBOUNCE_MS);
    expect(delivered).toHaveLength(1);
    await advance(PUSH_MIN_INTERVAL_MS);
    expect(delivered).toEqual([['phone-a', 'm1'], ['phone-a', 'm2']]);
  });

  it('stage 1 needs no push grant at all', async () => {
    vi.useFakeTimers();
    const { sink, sent, delivered, advance } = setup({ devices: [{ deviceId: 'phone-a' }], live: ['phone-a'], streams: ['phone-a'] });
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    expect(delivered).toEqual([['phone-a', 'm']]);
    expect(sent).toHaveLength(0);
  });

  it('each phone gets one path: the open one its stream, the asleep one the relay', async () => {
    vi.useFakeTimers();
    const grant = (id: string) => ({ deviceId: id, push: { grant: `${id}-grant`, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 } });
    const { sink, sent, delivered, advance } = setup({ devices: [grant('open'), grant('asleep')], live: ['open'], streams: ['open'] });
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    expect(delivered.map(([id]) => id)).toEqual(['open']);
    expect(sent.map((one) => JSON.parse(one.body).grant)).toEqual(['asleep-grant']);
  });

  it('sends nothing under CEZ_PUSH=0 or with no grant', async () => {
    vi.useFakeTimers();
    const off = setup({ enabled: false });
    off.sink.signal('m');
    await off.advance(PUSH_DEBOUNCE_MS);
    expect(off.sent).toHaveLength(0);
    const none = setup({ devices: [{ deviceId: 'phone-a' }] });
    none.sink.signal('m');
    await none.advance(PUSH_DEBOUNCE_MS);
    expect(none.sent).toHaveLength(0);
    expect(none.sink.latestManager()).toBeUndefined();
  });

  it.each([403, 410])('deletes the grant on %i', async (status) => {
    vi.useFakeTimers();
    const { sink, dropped, advance } = setup({ status });
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    expect(dropped).toEqual([`phone-a:${GRANT_ID}`]);
  });

  it.each([400, 401, 409, 429, 503])('keeps the grant on %i', async (status) => {
    vi.useFakeTimers();
    const { sink, dropped, advance } = setup({ status });
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    expect(dropped).toEqual([]);
  });

  it('drops an expired grant without asking the relay', async () => {
    vi.useFakeTimers();
    const { sink, sent, dropped, advance } = setup({ devices: [{ deviceId: 'phone-a', push: { grant: GRANT, grantId: GRANT_ID, expiresAt: NOW / 1000 - 1 } }] });
    sink.signal('m');
    await advance(PUSH_DEBOUNCE_MS);
    expect(sent).toHaveLength(0);
    expect(dropped).toEqual([`phone-a:${GRANT_ID}`]);
  });

  it('keeps the badge in the protocol range, down to 0', () => {
    expect([badgeCount(0), badgeCount(-3), badgeCount(5), badgeCount(500), badgeCount(Number.NaN)]).toEqual([0, 0, 5, 99, 0]);
    expect(JSON.parse(pushBody('g', 1, 'i', 2))).toEqual({ v: 1, grant: 'g', kind: 'attention', count: 1, id: 'i', ts: 2 });
  });

  describe('per-phone settings (spec 2026-11-20-phone-notifications-inbox)', () => {
    const grant = (deviceId: string, notifications?: PushGrantRow['notifications']): PushGrantRow => ({
      deviceId,
      push: { grant: `${GRANT}-${deviceId}`, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 },
      acceptsCount: true,
      ...(notifications ? { notifications } : {}),
    });
    const kinds = (sent: Sent[]) => sent.map((one) => (JSON.parse(one.body) as { kind: string }).kind);

    it('pushes only to a phone that chose the kind, each with its own count', async () => {
      vi.useFakeTimers();
      const { sink, sent, advance } = setup({
        devices: [grant('all'), grant('approvals', { push: ['approval'], badge: ['approval'], quietHours: null })],
        count: async (badge) => (badge.length === 1 ? 1 : 4),
      });
      sink.signal('m', 'message');
      await advance(PUSH_DEBOUNCE_MS);
      expect(sent.map((one) => JSON.parse(one.body) as { grant: string; count: number }).map(({ grant, count }) => [grant, count]))
        .toEqual([[`${GRANT}-all`, 4]]);
      await advance(PUSH_MIN_INTERVAL_MS);
      sink.signal('m', 'approval');
      await advance(PUSH_DEBOUNCE_MS);
      // Between the two, the approvals-only phone learned its count by a silent count push.
      const alerts = sent.slice(1).map((one) => JSON.parse(one.body) as { kind: string; count: number }).filter((body) => body.kind === 'attention');
      expect(alerts.map((body) => body.count).sort()).toEqual([1, 4]);
    });

    it('holds a push during quiet hours and sends one when they end, if anything still waits', async () => {
      vi.useFakeTimers();
      const start = new Date(NOW);
      const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const minute = start.getHours() * 60 + start.getMinutes();
      const quietHours = { start: clock(minute), end: clock(minute + 60) };
      const { sink, sent, advance } = setup({ devices: [grant('quiet', { push: ['message'], badge: ['message'], quietHours })] });
      sink.signal('m', 'message');
      await advance(PUSH_DEBOUNCE_MS);
      expect(sent).toHaveLength(0);
      await advance(60 * 60_000);
      expect(kinds(sent)).toEqual(['attention']);
    });

    it('reads quiet hours that span midnight', () => {
      const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
      const night = { start: '22:00', end: '07:00' };
      expect(quietUntil(night, at(23))).toBe(new Date(2026, 10, 21, 7).getTime());
      expect(quietUntil(night, at(6, 59))).toBe(at(7));
      expect(quietUntil(night, at(12))).toBeNull();
      expect(quietUntil({ start: '08:00', end: '08:00' }, at(8))).toBeNull();
      expect(quietUntil(null, at(8))).toBeNull();
    });
  });

  describe('count pushes (RELAY_PROTOCOL.md § 7)', () => {
    it('tells a closed phone its new count silently, with a fresh id, and nothing when it is unchanged', async () => {
      vi.useFakeTimers();
      let count = 3;
      const { sink, sent, advance } = setup({ count: async () => count });
      sink.signal('m', 'question');
      await advance(PUSH_DEBOUNCE_MS);
      count = 1;
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      expect(sent.map((one) => JSON.parse(one.body) as Record<string, unknown>).map(({ kind, count: n }) => [kind, n]))
        .toEqual([['attention', 3], ['count', 1]]);
      const body = JSON.parse(sent[1]!.body) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['count', 'grant', 'id', 'kind', 'ts', 'v']);
      expect(body.id).not.toBe((JSON.parse(sent[0]!.body) as { id: string }).id);
      sink.noteChange();
      await advance(COUNT_MIN_INTERVAL_MS);
      expect(sent).toHaveLength(2);
    });

    it('sends 0 when everything was handled, never to a phone whose app is open, nor to an app that cannot read it', async () => {
      vi.useFakeTimers();
      let count = 2;
      const { sink, sent, advance } = setup({
        devices: [
          { deviceId: 'closed', push: { grant: 'g-closed', grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 }, acceptsCount: true },
          { deviceId: 'open', push: { grant: 'g-open', grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 }, acceptsCount: true },
          // An app that never said it reads count pushes would show one as an alert.
          { deviceId: 'older-app', push: { grant: 'g-older', grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 } },
        ],
        live: ['open'],
        count: async () => count,
      });
      count = 0;
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      expect(sent.map((one) => JSON.parse(one.body) as { grant: string; kind: string; count: number }).map(({ grant, kind, count: n }) => [grant, kind, n]))
        .toEqual([['g-closed', 'count', 0]]);
    });

    it('keeps one count push per phone per 10 minutes, sending only the latest', async () => {
      vi.useFakeTimers();
      let count = 5;
      const { sink, sent, advance } = setup({ count: async () => count });
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      count = 4;
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      count = 3;
      sink.noteChange();
      await advance(COUNT_MIN_INTERVAL_MS);
      expect(sent.map((one) => (JSON.parse(one.body) as { count: number }).count)).toEqual([5, 3]);
    });

    it('retries after a 429 with the latest count and a new id', async () => {
      vi.useFakeTimers();
      let count = 2;
      let refuse = true;
      const { sink, sent, advance } = setup({
        count: async () => count,
        answer: () => (refuse ? { status: 429, retryAfter: 120 } : { status: 202 }),
      });
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      refuse = false;
      count = 1;
      await advance(120_000);
      const bodies = sent.map((one) => JSON.parse(one.body) as { count: number; id: string });
      expect(bodies.map((body) => body.count)).toEqual([2, 1]);
      expect(bodies[0]!.id).not.toBe(bodies[1]!.id);
    });

    it('stops count pushes, with one warning, on a relay that does not know the kind', async () => {
      vi.useFakeTimers();
      let count = 2;
      const warnings: string[] = [];
      const { sink, sent, advance } = setup({ count: async () => count, answer: () => ({ status: 400 }), warn: (line) => warnings.push(line) });
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      count = 1;
      sink.noteChange();
      await advance(COUNT_MIN_INTERVAL_MS);
      expect(sent).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    });
  });
});

import { randomBytes, verify, createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64u, edPublic, postProof } from '../relay/wire.ts';
import { DEFAULT_PHONE_PUSH_PREFS, type AttentionKind } from '@open-mercato/cezar-contract';
import { COUNT_DEBOUNCE_MS, COUNT_MIN_INTERVAL_MS, PUSH_DEBOUNCE_MS, PUSH_MIN_INTERVAL_MS, RelayPushSink, badgeCount, pushBody, quietUntil, type PushGrantRow } from './relay-sink.ts';

const ORIGIN = 'https://relay.example.test';
const SEED = randomBytes(32);
const GRANT = 'sealed-grant';
const GRANT_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_793_491_200_000;

interface Sent { url: string; headers: Record<string, string>; body: string }

/** An app that declared it reads count pushes (spec 2026-11-20-phone-notifications-inbox). */
const COUNTING = { ...DEFAULT_PHONE_PUSH_PREFS, understands: ['attention', 'count'] as Array<'attention' | 'count'> };

function setup(over: {
  devices?: PushGrantRow[]; live?: string[]; streams?: string[]; status?: number; enabled?: boolean;
  count?: (kinds: readonly AttentionKind[]) => Promise<number>;
  answer?: (body: Record<string, unknown>) => { status: number; retryAfter?: number };
  warn?: (line: string) => void;
  /** The count the phone was last pushed, as stored before a restart. */
  told?: number;
} = {}) {
  let now = NOW;
  const sent: Sent[] = [];
  const dropped: string[] = [];
  const delivered: Array<[string, string | undefined]> = [];
  const devices: PushGrantRow[] = over.devices ?? [{ deviceId: 'phone-a', push: { grant: GRANT, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 }, prefs: COUNTING, ...(over.told !== undefined ? { countTold: over.told } : {}) }];
  const told: Array<[string, number]> = [];
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
    setCountTold: (id, count) => { told.push([id, count]); },
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
  return { sink, sent, dropped, delivered, advance, told };
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
    const grant = (deviceId: string, prefs?: Partial<NonNullable<PushGrantRow['prefs']>>): PushGrantRow => ({
      deviceId,
      push: { grant: `${GRANT}-${deviceId}`, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 },
      prefs: { ...COUNTING, ...prefs },
    });
    const kinds = (sent: Sent[]) => sent.map((one) => (JSON.parse(one.body) as { kind: string }).kind);

    it('pushes only to a phone that chose the kind, each with its own count', async () => {
      vi.useFakeTimers();
      const { sink, sent, advance } = setup({
        devices: [grant('all'), grant('approvals', { push: ['approval'], icon: ['approval'] })],
        count: async (badge) => (badge.length === 1 ? 1 : 4),
      });
      sink.signal('m', 'message');
      await advance(PUSH_DEBOUNCE_MS);
      expect(sent.map((one) => JSON.parse(one.body) as { grant: string; count: number }).map(({ grant, count }) => [grant, count]))
        .toEqual([[`${GRANT}-all`, 4]]);
      await advance(PUSH_MIN_INTERVAL_MS);
      sink.signal('m', 'approval');
      await advance(PUSH_DEBOUNCE_MS);
      const alerts = sent.slice(1).map((one) => JSON.parse(one.body) as { kind: string; count: number }).filter((body) => body.kind === 'attention');
      expect(alerts.map((body) => body.count).sort()).toEqual([1, 4]);
    });

    it('holds a push during quiet hours and sends one when they end, if anything still waits', async () => {
      vi.useFakeTimers();
      const start = new Date(NOW);
      const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const minute = start.getUTCHours() * 60 + start.getUTCMinutes();
      const quiet = { from: clock(minute), to: clock(minute + 60), timeZone: 'UTC' };
      const { sink, sent, advance } = setup({ devices: [grant('quiet', { push: ['message'], icon: ['message'], quiet })] });
      sink.signal('m', 'message');
      await advance(PUSH_DEBOUNCE_MS);
      expect(sent).toHaveLength(0);
      await advance(60 * 60_000);
      expect(kinds(sent)).toEqual(['attention']);
    });

    // Review of #2367: under the default prefs a failed task pushes but is not on the icon.
    it('alerts for a failed task under the default prefs, with a badge of 1 that no count push takes back', async () => {
      vi.useFakeTimers();
      const row: PushGrantRow = { deviceId: 'phone-a', push: { grant: GRANT, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 }, prefs: COUNTING };
      const { sink, sent, advance, told } = setup({ devices: [row], count: async (icon) => (icon.includes('failed') ? 1 : 0) });
      sink.signal('m', 'failed');
      await advance(PUSH_DEBOUNCE_MS);
      expect(sent.map((one) => JSON.parse(one.body) as { kind: string; count: number }).map(({ kind, count }) => [kind, count])).toEqual([['attention', 1]]);
      // The phone is told its icon count, 0, so the next count push does not clear the alert's badge.
      expect(told).toEqual([['phone-a', 0]]);
      await advance(COUNT_MIN_INTERVAL_MS);
      expect(sent).toHaveLength(1);
    });

    it('releases a phone whose quiet hours end first, even when another phone was held before it', async () => {
      vi.useFakeTimers();
      const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const start = new Date(NOW);
      const minute = start.getUTCHours() * 60 + start.getUTCMinutes();
      const quiet = (minutes: number) => ({ from: clock(minute), to: clock(minute + minutes), timeZone: 'UTC' });
      const late = grant('late', { push: ['message'], quiet: quiet(120) });
      const soon = grant('soon', { push: ['approval'], quiet: quiet(30) });
      const { sink, sent, advance } = setup({ devices: [late, soon] });
      sink.signal('m', 'message');
      await advance(PUSH_MIN_INTERVAL_MS);
      sink.signal('m', 'approval');
      await advance(PUSH_MIN_INTERVAL_MS);
      expect(sent).toHaveLength(0);
      await advance(30 * 60_000 - 2 * PUSH_MIN_INTERVAL_MS);
      expect(sent.map((one) => (JSON.parse(one.body) as { grant: string }).grant)).toEqual([`${GRANT}-soon`]);
      await advance(90 * 60_000);
      expect(sent.map((one) => (JSON.parse(one.body) as { grant: string }).grant)).toEqual([`${GRANT}-soon`, `${GRANT}-late`]);
    });

    it('reads quiet hours in the phone’s own time zone, across midnight', () => {
      const at = (h: number, m = 0) => Date.UTC(2026, 10, 20, h, m);
      const night = { from: '22:00', to: '07:00', timeZone: 'UTC' };
      expect(quietUntil(night, at(23))).toBe(Date.UTC(2026, 10, 21, 7));
      expect(quietUntil(night, at(6, 59))).toBe(at(7));
      expect(quietUntil(night, at(12))).toBeNull();
      expect(quietUntil({ ...night, from: '08:00', to: '08:00' }, at(8))).toBeNull();
      expect(quietUntil(undefined, at(8))).toBeNull();
      // 23:00 UTC is 08:00 in Tokyo: outside a Tokyo night, though inside a UTC one.
      expect(quietUntil({ ...night, timeZone: 'Asia/Tokyo' }, at(23))).toBeNull();
      expect(quietUntil({ ...night, timeZone: 'Asia/Tokyo' }, at(14))).toBe(at(22));
    });
  });

  describe('count pushes (RELAY_PROTOCOL.md § 7)', () => {
    it('tells a closed phone its lower count silently, with a fresh id, and keeps the count it told', async () => {
      vi.useFakeTimers();
      let count = 3;
      const { sink, sent, advance, told } = setup({ count: async () => count });
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
      expect(told).toEqual([['phone-a', 3], ['phone-a', 1]]);
    });

    it('owes nothing until the phone knows a number, then follows it up as well as down', async () => {
      vi.useFakeTimers();
      let count = 2;
      const { sink, sent, advance } = setup({ count: async () => count });
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      expect(sent).toHaveLength(0);
      // A kind counted on the icon but not pushed still moves the icon (spec § Relay change).
      const after = setup({ count: async () => count, told: 1 });
      count = 4;
      after.sink.noteChange();
      await after.advance(COUNT_DEBOUNCE_MS);
      expect(after.sent.map((one) => JSON.parse(one.body) as { kind: string; count: number }).map(({ kind, count: n }) => [kind, n])).toEqual([['count', 4]]);
    });

    it('takes what the phone shows when its app opens as what it was told', async () => {
      vi.useFakeTimers();
      let count = 3;
      const { sink, sent, advance, told } = setup({ count: async () => count });
      await sink.noteOpened('phone-a');
      expect(told).toEqual([['phone-a', 3]]);
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      expect(sent).toHaveLength(0);
      count = 1;
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      expect(sent.map((one) => (JSON.parse(one.body) as { count: number }).count)).toEqual([1]);
    });

    it('sends 0 when everything was handled, never to a phone whose app is open, nor to an app that cannot read it', async () => {
      vi.useFakeTimers();
      // Each was told 2 before a restart, kept on its device row.
      const row = (deviceId: string, prefs = COUNTING): PushGrantRow => ({ deviceId, push: { grant: `g-${deviceId}`, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 }, prefs, countTold: 2 });
      const { sink, sent, advance } = setup({
        devices: [
          row('closed'),
          row('open'),
          // A released app never declared `count`: it would show one as an alert.
          row('older-app', DEFAULT_PHONE_PUSH_PREFS),
        ],
        live: ['open'],
        count: async () => 0,
      });
      sink.noteChange();
      await advance(COUNT_DEBOUNCE_MS);
      expect(sent.map((one) => JSON.parse(one.body) as { grant: string; kind: string; count: number }).map(({ grant, kind, count: n }) => [grant, kind, n]))
        .toEqual([['g-closed', 'count', 0]]);
    });

    it('keeps one count push per phone per 10 minutes, sending only the latest', async () => {
      vi.useFakeTimers();
      let count = 5;
      const { sink, sent, advance } = setup({ count: async () => count, told: 6 });
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
        told: 3,
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
      const { sink, sent, advance } = setup({ count: async () => count, told: 3, answer: () => ({ status: 400 }), warn: (line) => warnings.push(line) });
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

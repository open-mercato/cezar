import { randomBytes, verify, createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64u, edPublic, postProof } from '../relay/wire.ts';
import { PUSH_DEBOUNCE_MS, PUSH_MIN_INTERVAL_MS, RelayPushSink, badgeCount, pushBody, type PushGrantRow } from './relay-sink.ts';

const ORIGIN = 'https://relay.example.test';
const SEED = randomBytes(32);
const GRANT = 'sealed-grant';
const GRANT_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_793_491_200_000;

interface Sent { url: string; headers: Record<string, string>; body: string }

function setup(over: { devices?: PushGrantRow[]; live?: string[]; streams?: string[]; status?: number; enabled?: boolean } = {}) {
  let now = NOW;
  const sent: Sent[] = [];
  const dropped: string[] = [];
  const delivered: Array<[string, string | undefined]> = [];
  const devices: PushGrantRow[] = over.devices ?? [{ deviceId: 'phone-a', push: { grant: GRANT, grantId: GRANT_ID, expiresAt: NOW / 1000 + 86_400 } }];
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
    count: async () => 3,
    post: async (url, { headers, body }) => {
      sent.push({ url, headers, body: Buffer.from(body).toString('utf8') });
      return { status: over.status ?? 202 };
    },
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

  it('keeps the badge in the protocol range', () => {
    expect([badgeCount(0), badgeCount(5), badgeCount(500), badgeCount(Number.NaN)]).toEqual([1, 5, 99, 1]);
    expect(JSON.parse(pushBody('g', 1, 'i', 2))).toEqual({ v: 1, grant: 'g', kind: 'attention', count: 1, id: 'i', ts: 2 });
  });
});

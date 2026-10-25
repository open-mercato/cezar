import { describe, expect, it, vi } from 'vitest';
import { TrackerHttp, TrackerRequestError, ResultCache, runOperation } from './transport.ts';

describe('bounded tracker requests', () => {
  it('rejects declared and streamed oversized bodies without echoing payloads', async () => {
    for (const response of [new Response('secret', { headers: { 'content-length': '2097153' } }), new Response('x'.repeat(2097153))]) {
      const client = new TrackerHttp(vi.fn().mockResolvedValue(response));
      await expect(runOperation(signal => client.json('https://example.test', {}, signal))).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('maps credentials and missing objects separately, hiding vendor error text', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [503, 'unavailable']] as const) {
      const client = new TrackerHttp(vi.fn().mockResolvedValue(new Response('Authorization: sensitive', { status })));
      await expect(runOperation(signal => client.json('https://example.test', {}, signal))).rejects.toMatchObject({ code });
    }
  });
  it('honors rate-limit cooldown even on subsequent requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    const client = new TrackerHttp(fetcher);
    for (let n = 0; n < 2; n++) await expect(runOperation(signal => client.json('https://example.test', {}, signal))).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds even a fetch implementation that ignores cancellation', async () => {
    const client = new TrackerHttp(() => new Promise(() => {}));
    await expect(runOperation(signal => client.json('https://example.test', {}, signal), 10)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rejects invalid JSON and does not forward redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('not-json'));
    await expect(runOperation(signal => new TrackerHttp(fetcher).json('https://example.test', {}, signal))).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
});

describe('result cache', () => {
  it('coalesces requests, expires success, never caches failure, and bounds entries', async () => {
    let now = 0;
    const cache = new ResultCache<{ available: boolean; value: number }>(2, 60, () => now);
    const read = vi.fn(async () => ({ available: true, value: 1 }));
    await Promise.all([cache.get('a', read), cache.get('a', read)]);
    expect(read).toHaveBeenCalledTimes(1);
    now = 61;
    await cache.get('a', read);
    expect(read).toHaveBeenCalledTimes(2);
    await cache.get('b', read); await cache.get('c', read); await cache.get('a', read);
    expect(read).toHaveBeenCalledTimes(5);
    const fail = vi.fn(async () => ({ available: false, value: 0 }));
    await cache.get('f', fail); await cache.get('f', fail);
    expect(fail).toHaveBeenCalledTimes(2);
  });
  it('does not repopulate invalidated cache with an old in-flight read', async () => {
    const cache = new ResultCache<{ available: boolean; value: number }>();
    let complete!: (value: { available: boolean; value: number }) => void;
    const pending = cache.get('a', () => new Promise(resolve => { complete = resolve; }));
    cache.clear();
    complete({ available: true, value: 1 }); await pending;
    const next = vi.fn(async () => ({ available: true, value: 2 }));
    expect(await cache.get('a', next)).toMatchObject({ value: 2 });
  });
  it('preserves controlled errors', () => expect(new TrackerRequestError('unauthorized', 'Check credentials').message).toBe('Check credentials'));
});

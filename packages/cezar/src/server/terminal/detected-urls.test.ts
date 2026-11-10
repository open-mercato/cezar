import { describe, expect, it, vi } from 'vitest';

import { DetectedUrls, MAX_URLS_PER_RUN, PROBE_CONCURRENCY, PROBE_REUSE_MS, findUrls, normalizeUrl, portOf } from './detected-urls.ts';

describe('findUrls', () => {
  it('finds what a dev server announces', () => {
    const output = [
      '  VITE v8.1.4  ready in 326 ms',
      '  ➜  Local:   http://localhost:5199/',
      '  ➜  Network: http://192.168.0.10:5199/',
    ].join('\n');
    // Only the loopback one: a LAN address is not something this cockpit can usefully open,
    // and listing it would promise a reachability we have not checked.
    expect(findUrls(output)).toEqual(['http://localhost:5199']);
  });

  it('rewrites the bound interface to one a browser can open', () => {
    expect(findUrls('Listening on http://0.0.0.0:3000')).toEqual(['http://localhost:3000']);
  });

  it('treats a trailing slash as the same address', () => {
    expect(findUrls('http://localhost:3000/ and http://localhost:3000')).toEqual(['http://localhost:3000']);
  });

  it('keeps a real path, which is a different page', () => {
    expect(findUrls('http://localhost:3000/admin')).toEqual(['http://localhost:3000/admin']);
  });

  it('ignores the documentation and registry links a terminal is full of', () => {
    const noise = 'see https://nodejs.org/api and https://registry.npmjs.org/foo for details';
    expect(findUrls(noise)).toEqual([]);
  });

  it('does not trip over surrounding punctuation', () => {
    expect(findUrls('open (http://localhost:8080) now')).toEqual(['http://localhost:8080']);
  });

  it('reads through the colors a dev server paints its port in', () => {
    // Vite 7 / Vite+: the port is bold, so a raw match stopped at `localhost:` and lost it.
    const output = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5177\x1b[22m/\x1b[39m';
    expect(findUrls(output)).toEqual(['http://localhost:5177']);
  });

  it('has nothing to say about ordinary output', () => {
    expect(findUrls('npm warn deprecated something@1.0.0')).toEqual([]);
  });
});

describe('normalizeUrl', () => {
  it('refuses something that is not a url', () => {
    expect(normalizeUrl('http://')).toBeNull();
  });
});

describe('portOf', () => {
  it('fills in the protocol default', () => {
    expect(portOf('http://localhost')).toEqual({ host: 'localhost', port: 80 });
    expect(portOf('https://localhost')).toEqual({ host: 'localhost', port: 443 });
  });

  it('reads an explicit port', () => {
    expect(portOf('http://localhost:5199')).toEqual({ host: 'localhost', port: 5199 });
  });

  it('refuses nonsense', () => {
    expect(portOf('not a url')).toBeNull();
  });
});

describe('DetectedUrls', () => {
  it('collects a run’s addresses and keeps tasks apart', () => {
    const urls = new DetectedUrls();
    expect(urls.record('run-1', 'up at http://localhost:3000')).toBe(true);
    urls.record('run-2', 'up at http://localhost:4000');
    expect(urls.list('run-1').map((row) => row.url)).toEqual(['http://localhost:3000']);
    expect(urls.list('run-2').map((row) => row.url)).toEqual(['http://localhost:4000']);
  });

  it('says when nothing was found, so a caller can skip publishing', () => {
    expect(new DetectedUrls().record('run-1', 'just some logging')).toBe(false);
  });

  it('updates the existing row on a re-print instead of adding one', () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:3000', new Date('2026-10-07T10:00:00Z'));
    urls.record('run-1', 'http://localhost:3000', new Date('2026-10-07T11:00:00Z'));
    expect(urls.list('run-1')).toHaveLength(1);
    expect(urls.list('run-1')[0]!.lastSeenAt).toBe('2026-10-07T11:00:00.000Z');
  });

  it('clears a stale dead mark when the address is printed again', async () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:3000');
    await urls.refresh('run-1', async () => false);
    expect(urls.list('run-1')[0]!.running).toBe(false);

    // A restarted server reprints its address; it must not keep looking dead until the next probe.
    urls.record('run-1', 'http://localhost:3000');
    expect(urls.list('run-1')[0]!.running).toBeNull();
  });

  it('folds probe answers back into the rows', async () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:3000 http://localhost:4000');
    const probe = vi.fn(async (url: string) => url.endsWith('3000'));
    const rows = await urls.refresh('run-1', probe);
    expect(rows.map((row) => [row.url, row.running])).toEqual([
      ['http://localhost:3000', true],
      ['http://localhost:4000', false],
    ]);
  });

  it('has nothing to refresh for a run it never saw', async () => {
    expect(await new DetectedUrls().refresh('nobody')).toEqual([]);
  });

  it('forgets a task', () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:3000');
    urls.forget('run-1');
    expect(urls.list('run-1')).toEqual([]);
  });
});

describe('DetectedUrls stays bounded (spec §7 — a log of request URLs is not a list of servers)', () => {
  const print = (urls: DetectedUrls, from: number, to: number, at: Date) => {
    for (let i = from; i < to; i += 1) urls.record('run-1', `GET http://localhost:3000/asset/${i}.js`, at);
  };

  it('caps a run’s table, dropping the least recently seen address', () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:5173', new Date('2026-10-07T10:00:00Z'));
    print(urls, 0, MAX_URLS_PER_RUN + 200, new Date('2026-10-07T10:01:00Z'));
    const kept = urls.list('run-1').map((row) => row.url);
    expect(kept).toHaveLength(MAX_URLS_PER_RUN);
    expect(kept).not.toContain('http://localhost:5173');
    expect(kept.at(-1)).toBe(`http://localhost:3000/asset/${MAX_URLS_PER_RUN + 199}.js`);
  });

  it('keeps an old address that was printed again over newer noise', () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:5173', new Date('2026-10-07T10:00:00Z'));
    print(urls, 0, MAX_URLS_PER_RUN - 1, new Date('2026-10-07T10:01:00Z'));
    urls.record('run-1', 'http://localhost:5173', new Date('2026-10-07T10:02:00Z'));
    print(urls, 1000, 1010, new Date('2026-10-07T10:03:00Z'));
    expect(urls.list('run-1').map((row) => row.url)).toContain('http://localhost:5173');
    expect(urls.list('run-1')).toHaveLength(MAX_URLS_PER_RUN);
  });

  it('probes each host:port once, however many paths were printed on it', async () => {
    const urls = new DetectedUrls();
    print(urls, 0, 30, new Date());
    urls.record('run-1', 'http://localhost:4000/a http://localhost:4000/b');
    const probe = vi.fn(async (url: string) => new URL(url).port === '3000');
    const rows = await urls.refresh('run-1', probe);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(rows.filter((row) => row.running).length).toBe(30);
    expect(rows.filter((row) => row.running === false).map((row) => row.url)).toEqual([
      'http://localhost:4000/a',
      'http://localhost:4000/b',
    ]);
  });

  it('never has more than a few probes open at once', async () => {
    const urls = new DetectedUrls();
    for (let port = 3000; port < 3040; port += 1) urls.record('run-1', `http://localhost:${port}`);
    let open = 0;
    let peak = 0;
    const probe = async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open -= 1;
      return true;
    };
    const rows = await urls.refresh('run-1', probe);
    expect(rows.every((row) => row.running === true)).toBe(true);
    expect(peak).toBeLessThanOrEqual(PROBE_CONCURRENCY);
  });

  it('reuses a probe answer for a moment, so two readers cost one connection', async () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:3000');
    urls.record('run-2', 'http://localhost:3000/other');
    const probe = vi.fn(async () => true);
    await Promise.all([urls.refresh('run-1', probe, 1_000), urls.refresh('run-2', probe, 1_000)]);
    await urls.refresh('run-1', probe, 1_500);
    expect(probe).toHaveBeenCalledTimes(1);
    // …but not for long: a server that stopped must be seen to have stopped.
    await urls.refresh('run-1', probe, 1_000 + PROBE_REUSE_MS + 1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a probe that throws reads as not running, and does not poison the next read', async () => {
    const urls = new DetectedUrls();
    urls.record('run-1', 'http://localhost:3000');
    const rows = await urls.refresh('run-1', async () => { throw new Error('boom'); }, 1_000);
    expect(rows[0]!.running).toBe(false);
  });
});

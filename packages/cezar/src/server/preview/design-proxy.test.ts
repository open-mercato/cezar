import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DesignProxies, injectPicker, parseDesignTarget } from './design-proxy.ts';
import { PICKER_PATH, pickerScript } from './picker-script.ts';

/**
 * The Design Mode proxy (spec `.ai/specs/2026-10-09-design-mode.md`).
 *
 * Everything here runs against a real loopback listener standing in for a task's dev server —
 * no network, no browser. What is pinned is the list in the module's header: it mirrors one
 * loopback origin and nothing else, it does its own `Host` check, it presents only its own pages
 * as same-origin, and every listener it opens has a way to close.
 */

const COCKPIT = 'http://localhost:4321';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      { host: '127.0.0.1', port: parsed.port, path: parsed.pathname + parsed.search, headers: { host: parsed.host, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the Design Mode proxy', () => {
  let upstream: Server;
  let upstreamOrigin: string;
  let seen: Seen[];
  let proxies: DesignProxies;
  /** Upgraded sockets leave the HTTP server's books, so `closeAllConnections` cannot reach them. */
  let upgraded: Duplex[];

  beforeEach(async () => {
    seen = [];
    upgraded = [];
    upstream = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `${upstreamOrigin}/landed` }).end();
        return;
      }
      if (req.url === '/away') {
        res.writeHead(302, { location: 'https://example.com/elsewhere' }).end();
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' }).end('console.log("<head>")');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><head><title>t</title></head><body><button id="go">Go</button></body></html>');
    });
    upstream.on('upgrade', (req, socket) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      upgraded.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello');
      socket.on('data', () => {});
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamOrigin = `http://localhost:${(upstream.address() as AddressInfo).port}`;
    proxies = new DesignProxies();
  });

  afterEach(async () => {
    proxies.closeAll();
    for (const socket of upgraded) socket.destroy();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const open = async (target = upstreamOrigin): Promise<string> => {
    const opened = await proxies.open({ target, parentOrigin: COCKPIT });
    if (!opened.ok) throw new Error(opened.reason);
    return opened.origin;
  };

  it('re-serves the app on its own loopback origin, keeping the hostname the user typed', async () => {
    const origin = await open();
    expect(origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(origin).not.toBe(upstreamOrigin);
    const page = await get(`${origin}/settings?tab=1`);
    expect(page.status).toBe(200);
    expect(seen.at(-1)!.url).toBe('/settings?tab=1');
    // The app sees its OWN host, which is what its dev-server host check expects.
    expect(seen.at(-1)!.headers.host).toBe(new URL(upstreamOrigin).host);
  });

  it('injects the picker into HTML, with a correct length, and into nothing else', async () => {
    const origin = await open();
    const page = await get(`${origin}/`);
    expect(page.body).toContain(`<head><script src="${PICKER_PATH}" data-cezar-design></script><title>`);
    expect(Number(page.headers['content-length'])).toBe(Buffer.byteLength(page.body));
    const script = await get(`${origin}/app.js`);
    expect(script.body).toBe('console.log("<head>")');
  });

  it('serves the picker bound to the cockpit origin and the real app origin', async () => {
    const origin = await open();
    const picker = await get(`${origin}${PICKER_PATH}`);
    expect(picker.status).toBe(200);
    expect(picker.headers['content-type']).toContain('javascript');
    expect(picker.body).toContain(`"parentOrigin":"${COCKPIT}"`);
    expect(picker.body).toContain(`"upstreamOrigin":"${upstreamOrigin}"`);
    // Never forwarded: the app has no such file, and must not be asked for it.
    expect(seen.some((entry) => entry.url === PICKER_PATH)).toBe(false);
  });

  it('refuses a request whose Host is not loopback — the DNS-rebinding case', async () => {
    const origin = await open();
    const port = new URL(origin).port;
    const answer = await get(`${origin}/`, { host: `evil.example:${port}` });
    expect(answer.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('presents only its own pages as same-origin to the app', async () => {
    const origin = await open();
    await get(`${origin}/api`, { origin, referer: `${origin}/page` });
    expect(seen.at(-1)!.headers.origin).toBe(upstreamOrigin);
    expect(seen.at(-1)!.headers.referer).toBe(`${upstreamOrigin}/page`);
    // A foreign origin reaches the app exactly as sent, so the app's CORS/CSRF rules still judge it.
    await get(`${origin}/api`, { origin: 'https://evil.example' });
    expect(seen.at(-1)!.headers.origin).toBe('https://evil.example');
  });

  it('keeps a redirect to the app inside the proxy and lets any other leave', async () => {
    const origin = await open();
    expect((await get(`${origin}/redirect`)).headers.location).toBe(`${origin}/landed`);
    expect((await get(`${origin}/away`)).headers.location).toBe('https://example.com/elsewhere');
  });

  it('splices a WebSocket upgrade through to the app', async () => {
    const origin = await open();
    const socket = connect(Number(new URL(origin).port), '127.0.0.1');
    const received = await new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('connect', () => {
        socket.write(`GET /hmr HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
      });
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.endsWith('hello')) resolve(data);
      });
      socket.on('error', reject);
    });
    socket.destroy();
    expect(received).toContain('101 Switching Protocols');
    const upgrade = seen.find((entry) => entry.url === '/hmr')!;
    expect(upgrade.headers.upgrade).toBe('websocket');
    expect(upgrade.headers.origin).toBe(upstreamOrigin);
  });

  it('answers 502 with a reason when the app is gone', async () => {
    const origin = await open();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const answer = await get(`${origin}/`);
    expect(answer.status).toBe(502);
    expect(answer.body).toContain('is the app still running');
    // afterEach closes it again; a second close on a closed server only reports an error.
    upstream = createServer();
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  });

  it('is idempotent per target and closes every listener it opened', async () => {
    const first = await open();
    expect(await open()).toBe(first);
    expect(proxies.size).toBe(1);
    proxies.closeAll();
    expect(proxies.size).toBe(0);
    await expect(get(`${first}/`)).rejects.toThrow();
  });

  it('evicts the least recently used listener at the cap', async () => {
    const capped = new DesignProxies({ max: 2 });
    try {
      const a = await capped.open({ target: 'http://localhost:1001', parentOrigin: COCKPIT });
      await capped.open({ target: 'http://localhost:1002', parentOrigin: COCKPIT });
      await capped.open({ target: 'http://localhost:1003', parentOrigin: COCKPIT });
      expect(capped.size).toBe(2);
      if (!a.ok) throw new Error(a.reason);
      await expect(get(`${a.origin}/`)).rejects.toThrow();
    } finally {
      capped.closeAll();
    }
  });

  it('closes a listener nothing has used for the idle window', async () => {
    const brief = new DesignProxies({ idleMs: 1_000 });
    try {
      await brief.open({ target: upstreamOrigin, parentOrigin: COCKPIT });
      expect(brief.size).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      expect(brief.size).toBe(0);
    } finally {
      brief.closeAll();
    }
  });

  it.each([
    ['an external site', 'http://example.com'],
    ['a rebinding-shaped hostname', 'http://127.0.0.1.evil.example:3000'],
    ['https', 'https://localhost:3000'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['not an address', 'nope'],
  ])('refuses %s', async (_label, target) => {
    const opened = await proxies.open({ target, parentOrigin: COCKPIT });
    expect(opened.ok).toBe(false);
    expect(proxies.size).toBe(0);
  });

  it('refuses a cockpit that is not local', async () => {
    const opened = await proxies.open({ target: upstreamOrigin, parentOrigin: 'https://cezar.example.com' });
    expect(opened.ok).toBe(false);
  });

  it('refuses to mirror cezar itself, under any loopback spelling', async () => {
    for (const target of ['http://localhost:4321', 'http://127.0.0.1:4321']) {
      expect((await proxies.open({ target, parentOrigin: COCKPIT })).ok).toBe(false);
    }
    const api = await proxies.open({ target: 'http://localhost:9999', parentOrigin: COCKPIT, forbidden: ['http://127.0.0.1:9999'] });
    expect(api.ok).toBe(false);
    expect(proxies.size).toBe(0);
  });
});

describe('parseDesignTarget', () => {
  it('reduces an address to its origin', () => {
    const parsed = parseDesignTarget('http://localhost:5173/deep/page?x=1#h');
    expect(parsed.ok && parsed.url.origin).toBe('http://localhost:5173');
  });
});

describe('injectPicker', () => {
  const tag = `<script src="${PICKER_PATH}" data-cezar-design></script>`;
  it.each([
    ['<html><head lang="en"><meta></head></html>', `<html><head lang="en">${tag}<meta></head></html>`],
    ['<!DOCTYPE html><html><body>x</body></html>', `<!DOCTYPE html><html>${tag}<body>x</body></html>`],
    ['<!doctype html><p>x</p>', `<!doctype html>${tag}<p>x</p>`],
    ['<p>fragment</p>', `${tag}<p>fragment</p>`],
  ])('places the tag as early as the document allows: %s', (html, expected) => {
    expect(injectPicker(html)).toBe(expected);
  });
});

describe('pickerScript', () => {
  it('is syntactically valid JavaScript with the config inlined', () => {
    const source = pickerScript({ parentOrigin: COCKPIT, upstreamOrigin: 'http://localhost:5173' });
    expect(source).not.toContain('__CEZAR_DESIGN_CONFIG__');
    expect(() => new Function(source)).not.toThrow();
  });

  it('keeps a hostile origin string inert', () => {
    const source = pickerScript({ parentOrigin: '</script><script>alert(1)', upstreamOrigin: '$&$1' });
    expect(source).not.toContain('</script>');
    expect(source).toContain('"upstreamOrigin":"$&$1"');
    expect(() => new Function(source)).not.toThrow();
  });
});

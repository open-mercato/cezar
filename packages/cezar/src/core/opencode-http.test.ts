import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OpencodeTransportError,
  openOpencodeEventStream,
  opencodeRequest,
} from './opencode-http.ts';

/**
 * The runner's door to `opencode serve` (#897). The property that matters is
 * negative and hard to observe directly — no client-side header or body
 * timeout — because opencode holds the prompt POST open for the whole agent
 * turn and undici's 300 s default used to cut it at exactly 5:00. These cases
 * pin the observable half: a response that takes its time still arrives, a
 * status is passed through rather than thrown, and a lost connection is
 * distinguishable from an answer.
 */
describe('opencode-http', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => {
        // An SSE response keeps its socket open forever — `close()` alone
        // would wait for it.
        s.closeAllConnections();
        return new Promise<void>((r) => s.close(() => r()));
      }),
    );
  });

  /** A url nothing is listening on — a server bound then closed, so the port
   *  is real and definitely free. */
  async function deadPort(): Promise<string> {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return url;
  }

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('sends a JSON body and returns the status with the raw response text', async () => {
    let seen = '';
    let seenType = '';
    const base = await serve((req, res) => {
      seenType = String(req.headers['content-type'] ?? '');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"ses_1"}');
      });
    });

    const res = await opencodeRequest(`${base}/session`, { method: 'POST', body: { title: 'cezar task' } });

    expect(seen).toBe('{"title":"cezar task"}');
    expect(seenType).toBe('application/json');
    expect(res).toEqual({ status: 200, body: '{"id":"ses_1"}' });
  });

  it('sends no body and no content-type when there is nothing to send', async () => {
    let seenType: string | undefined;
    const base = await serve((req, res) => {
      seenType = req.headers['content-type'];
      res.writeHead(204);
      res.end();
    });

    const res = await opencodeRequest(`${base}/session/x/abort`, { method: 'POST' });

    expect(seenType).toBeUndefined();
    expect(res).toEqual({ status: 204, body: '' });
  });

  it('a non-2xx status is an ANSWER — returned, never thrown', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('unknown model');
    });

    await expect(opencodeRequest(`${base}/session/x/message`, { method: 'POST', body: {} })).resolves.toEqual({
      status: 400,
      body: 'unknown model',
    });
  });

  it('a response that takes its time still arrives — nothing on this request has a clock', async () => {
    const base = await serve((_req, res) => {
      // Headers withheld, then a body in two pieces: the shape undici's
      // headersTimeout and bodyTimeout each police. There is no affordable way
      // to test 300 s; what is testable is that the request survives a delay
      // with no timeout of its own and no `socket.timeout` set.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":');
        setTimeout(() => res.end('true}'), 300);
      }, 300);
    });

    const started = Date.now();
    const res = await opencodeRequest(`${base}/session/x/message`, { method: 'POST', body: {} });

    expect(res).toEqual({ status: 200, body: '{"ok":true}' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  }, 15_000);

  it('a lost connection rejects with OpencodeTransportError, not a plain Error', async () => {
    const base = await serve((_req, res) => {
      res.destroy();
    });

    const err = await opencodeRequest(`${base}/session/x/message`, { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(OpencodeTransportError);
  });

  it('a server that is not there rejects with OpencodeTransportError', async () => {
    const base = await deadPort();

    const err = await opencodeRequest(`${base}/session`, { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpencodeTransportError);
  });

  it('an aborted request rejects with OpencodeTransportError', async () => {
    const base = await serve(() => {
      // never answers
    });
    const ac = new AbortController();
    const pending = opencodeRequest(`${base}/session/x/message`, {
      method: 'POST',
      body: {},
      signal: ac.signal,
    }).catch((e: unknown) => e);
    ac.abort();

    expect(await pending).toBeInstanceOf(OpencodeTransportError);
  });

  describe('the event stream', () => {
    it('resolves on the HEADERS, then delivers whole frames split on the blank line', async () => {
      let push: ((chunk: string) => void) | undefined;
      let finish: (() => void) | undefined;
      const base = await serve((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        push = (chunk) => res.write(chunk);
        finish = () => res.end();
      });

      const frames: string[] = [];
      let closed = false;
      const connected = await openOpencodeEventStream(`${base}/event`, {
        onFrame: (f) => frames.push(f),
        onClose: () => {
          closed = true;
        },
      });

      expect(connected).toBe(true);
      expect(frames).toEqual([]); // headers only so far — nothing streamed yet

      // A frame arriving in two writes must surface once, whole.
      push?.('data: {"type":"a"}\n\ndata: {"type"');
      await waitFor(() => frames.length === 1);
      expect(frames).toEqual(['data: {"type":"a"}']);
      push?.(':"b"}\n\n');
      await waitFor(() => frames.length === 2);
      expect(frames[1]).toBe('data: {"type":"b"}');

      expect(closed).toBe(false);
      finish?.();
      await waitFor(() => closed);
    }, 15_000);

    it('a non-2xx event bus is "not connected", and never reports a close', async () => {
      const base = await serve((_req, res) => {
        res.writeHead(404);
        res.end('no event bus');
      });

      let closed = false;
      const connected = await openOpencodeEventStream(`${base}/event`, {
        onFrame: () => undefined,
        onClose: () => {
          closed = true;
        },
      });

      expect(connected).toBe(false);
      expect(closed).toBe(false);
    });

    it('a server that is not there is "not connected"', async () => {
      const base = await deadPort();

      expect(await openOpencodeEventStream(`${base}/event`, { onFrame: () => undefined })).toBe(false);
    });

    it('aborting a live stream reports the close exactly once', async () => {
      const base = await serve((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"server.connected"}\n\n');
      });

      const ac = new AbortController();
      let closes = 0;
      const connected = await openOpencodeEventStream(`${base}/event`, {
        signal: ac.signal,
        onFrame: () => undefined,
        onClose: () => {
          closes += 1;
        },
      });
      expect(connected).toBe(true);

      ac.abort();
      await waitFor(() => closes > 0);
      await new Promise((r) => setTimeout(r, 50));
      expect(closes).toBe(1);
    }, 15_000);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

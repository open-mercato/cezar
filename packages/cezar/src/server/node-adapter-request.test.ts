import { createAdaptorServer, getRequestListener, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

describe('Node adapter request boundaries (Dependabot82/83)', () => {
  async function requestTarget(target: string) {
    // Exercise the actual adapter without binding a port in the fast unit suite.
    const socket = new Socket();
    const incoming = new IncomingMessage(socket);
    incoming.method = 'GET';
    incoming.url = target;
    incoming.headers = { host: 'localhost' };
    const outgoing = new ServerResponse(incoming);
    const fetch = vi.fn((request: Request) => new Response(request.url));
    try {
      await getRequestListener(fetch, { overrideGlobalObjects: false })(incoming, outgoing);
      return { status: outgoing.statusCode, fetch };
    } finally {
      incoming.destroy();
      outgoing.destroy();
      socket.destroy();
    }
  }

  it.each(['/admin\\secret', '/public\\..\\admin/secret'])(
    'rejects raw path backslashes before routing: %s', async (target) => {
      const response = await requestTarget(target);
      expect(response.status).toBe(400);
      expect(response.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['/admin%5Csecret', '/public?value=\\admin', '/ordinary'])(
    'preserves encoded backslashes, query values and ordinary paths: %s', async (target) => {
      const response = await requestTarget(target);
      expect(response.status).toBe(200);
      expect(response.fetch).toHaveBeenCalledOnce();
      expect(response.fetch.mock.calls[0]?.[0].url).toBe(`http://localhost${target}`);
    },
  );

  it('handles a socket reset while asynchronous upgrade middleware is pending', async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wss = new WebSocketServer({ noServer: true });
    const server = createAdaptorServer({
      fetch: async () => {
        entered();
        await pending;
        return new Response(null, { status: 403 });
      },
      websocket: { server: wss },
    });
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    const incoming = new IncomingMessage(socket as Socket);
    incoming.url = '/events';
    incoming.headers = { host: 'localhost', upgrade: 'websocket' };
    const upgrade = server.listeners('upgrade')[0] as (
      request: IncomingMessage, socket: Duplex, head: Buffer,
    ) => Promise<void>;
    const handling = upgrade(incoming, socket, Buffer.alloc(0));
    try {
      await started;
      // EventEmitter throws without the adapter's early listener, reproducing the
      // process-crash primitive deterministically without crashing this test runner.
      const reset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      expect(() => socket.emit('error', reset)).not.toThrow();
    } finally {
      socket.destroy();
      release();
      await handling;
      wss.close();
      server.close(() => {});
    }
  });

  it('does not attempt a handshake after a pending upgrade socket closes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wss = new WebSocketServer({ noServer: true });
    const handshake = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});
    const app = new Hono().get('/events', upgradeWebSocket(() => ({})));
    const server = createAdaptorServer({
      fetch: async (request, env) => {
        const response = await app.fetch(request, env);
        entered();
        await pending;
        return response;
      },
      websocket: { server: wss },
    });
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    const incoming = new IncomingMessage(socket as Socket);
    incoming.url = '/events';
    incoming.headers = { host: 'localhost', upgrade: 'websocket' };
    const upgrade = server.listeners('upgrade')[0] as (
      request: IncomingMessage, socket: Duplex, head: Buffer,
    ) => Promise<void>;
    const handling = upgrade(incoming, socket, Buffer.alloc(0));
    try {
      await started;
      socket.destroy();
      release();
      await handling;
      expect(handshake).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      release();
      await handling;
      wss.close();
      server.close(() => {});
    }
  });
});

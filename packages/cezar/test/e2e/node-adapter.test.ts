import { createAdaptorServer } from '@hono/node-server';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

// Keep socket-based coverage in test:package, outside the fast unit suites.
test('the Node adapter preserves JSON bodies, cookies and SSE over loopback', { timeout: 15_000 }, async () => {
  const app = new Hono();
  app.post('/echo', async (c) => {
    c.header('set-cookie', 'first=1; HttpOnly');
    c.header('set-cookie', 'second=2; HttpOnly', { append: true });
    return c.json({ body: await c.req.json(), header: c.req.header('x-test') }, 201);
  });
  app.get('/events', (c) => streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'message', id: '1', data: 'first' });
    await stream.writeSSE({ event: 'message', id: '2', data: 'second' });
  }));
  const server = createAdaptorServer({ fetch: app.fetch });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const body = { text: 'hello 炎', nested: { enabled: true } };
    const response = await fetch(`${origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'preserved' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { body, header: 'preserved' });
    assert.deepEqual(response.headers.getSetCookie(), ['first=1; HttpOnly', 'second=2; HttpOnly']);

    const events = await fetch(`${origin}/events`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type') ?? '', /^text\/event-stream/);
    const frames = await events.text();
    assert.deepEqual(frames.trim().split('\n\n').map((frame) => frame.split('\n').sort()), [
      ['event: message', 'id: 1', 'data: first'].sort(),
      ['event: message', 'id: 2', 'data: second'].sort(),
    ]);
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

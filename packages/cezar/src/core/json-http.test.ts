import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonRequest } from './json-http.js';

/**
 * Regression (2026-07-25, live run): an opencode reviewer was cut off at
 * exactly 5:01 — twice — and cezar reported only `fetch failed`.
 *
 * Cause: `POST /session/:id/message` sends no response headers until the model
 * finishes, and Node's global `fetch` (undici) defaults `headersTimeout` to
 * 300_000 ms. Any turn over five minutes was aborted with
 * `TypeError: fetch failed` / `UND_ERR_HEADERS_TIMEOUT`, silently overriding
 * cezar's own 30-minute run timeout.
 *
 * These tests pin the two properties that matter: the caller's timeout is the
 * ONLY deadline, and a blown deadline says so in words an operator can act on.
 */

let server: Server | null = null;

function slowServer(delayMs: number, status = 200, payload = '{"ok":true}'): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      }, delayMs).unref?.();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('jsonRequest', () => {
  it('waits for a slow response rather than imposing a hidden deadline of its own', async () => {
    const base = await slowServer(300);
    const res = await jsonRequest(`${base}/session/x/message`, {
      method: 'POST',
      body: { parts: [] },
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true });
  });

  it('honours the caller’s timeout — the only deadline there is', async () => {
    const base = await slowServer(5_000);
    const started = Date.now();
    await expect(
      jsonRequest(`${base}/session/x/message`, { method: 'POST', body: {}, timeoutMs: 250 }),
    ).rejects.toThrow(/timed out after 250ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('names the timeout and the path — never a bare "fetch failed"', async () => {
    const base = await slowServer(5_000);
    const err = await jsonRequest(`${base}/session/abc/message`, {
      method: 'POST',
      body: {},
      timeoutMs: 200,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('/session/abc/message');
    expect((err as Error).message).not.toMatch(/fetch failed/);
  });

  it('returns a non-2xx to the caller instead of throwing, body intact', async () => {
    const base = await slowServer(0, 500, '{"name":"UnknownError"}');
    const res = await jsonRequest(`${base}/session/x/message`, { method: 'POST', body: {}, timeoutMs: 5_000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.text).toContain('UnknownError');
  });

  it('surfaces a connection failure as a real error, not a timeout', async () => {
    await expect(
      jsonRequest('http://127.0.0.1:1/session/x/message', { method: 'POST', body: {}, timeoutMs: 2_000 }),
    ).rejects.toThrow(/ECONNREFUSED|connect/i);
  });

  it('treats a non-positive timeout as "no deadline" — the runner’s 0 = unlimited', async () => {
    const base = await slowServer(400);
    const res = await jsonRequest(`${base}/session/x/message`, { method: 'POST', body: {}, timeoutMs: 0 });
    expect(res.ok).toBe(true);
  });

  it('supports a GET with no body', async () => {
    const base = await slowServer(0, 200, '{"id":"ses_1"}');
    const res = await jsonRequest(`${base}/session`, { method: 'GET', timeoutMs: 5_000 });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.text)).toEqual({ id: 'ses_1' });
  });
});

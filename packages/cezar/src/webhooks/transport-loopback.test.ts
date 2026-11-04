import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
// Use a separate process: an unhandled BodyReadable error must fail this test
// rather than escape into Vitest's global error handler or kill its worker.
const client = `
  const { sendWebhook } = await import(process.argv[1]);
  const controller = new AbortController();
  if (process.argv[3] === 'abort') setTimeout(() => controller.abort(), 100);
  const result = await sendWebhook({
    format: process.argv[4] || undefined, url: process.argv[2], body: '{"test":true}', eventId: 'evt_loopback',
    secrets: ['whsec_' + Buffer.alloc(32, 7).toString('base64')],
    policy: { mode: 'local', allowLocalNetwork: true, serverPorts: [] },
    signal: controller.signal,
  });
  console.log(JSON.stringify(result));
`;

describe('real undici webhook response disposal', () => {
  it.each(['empty', 'body', 'stream', 'abort'] as const)('survives a %s response and closes the request', async mode => {
    let received = '';
    const server = createServer((request, response) => {
      request.setEncoding('utf8');
      request.on('data', chunk => { received += chunk; });
      request.on('end', () => {
        if (mode === 'abort') return; // No response headers: cancellation must release the socket.
        response.writeHead(mode === 'empty' ? 204 : 200, { 'content-type': 'text/plain' });
        if (mode === 'empty') response.end();
        else if (mode === 'body') response.end('private receiver details');
        else response.write('x'.repeat(8192)); // Never ends: disposal must not wait to drain it.
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const { stdout, stderr } = await exec(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', client,
        new URL('./transport.ts', import.meta.url).href,
        `http://127.0.0.1:${port}/webhook`, mode,
      ], { timeout: 5000 });
      expect(stderr).toBe('');
      if (mode !== 'abort') expect(received).toBe('{"test":true}');
      expect(JSON.parse(stdout)).toEqual(mode === 'abort'
        ? { kind: 'transient', reason: 'timeout' }
        : { kind: 'http', status: mode === 'empty' ? 204 : 200, contentType: 'text/plain' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 10000);
});

describe('real chat wire headers', () => {
  it.each(['slack.v1', 'discord.v1'])('posts %s without cezar signature headers', async format => {
    let headers: Record<string, unknown> = {};
    const server = createServer((request, response) => {
      headers = request.headers;
      request.resume(); request.on('end', () => { response.writeHead(204); response.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', client,
        new URL('./transport.ts', import.meta.url).href, `http://127.0.0.1:${port}/webhook`, 'empty', format], { timeout: 5000 });
      expect(stderr).toBe(''); expect(JSON.parse(stdout)).toMatchObject({ kind: 'http', status: 204 });
      expect(headers['content-type']).toBe('application/json');
      expect(Object.keys(headers).filter(key => key.startsWith('webhook-'))).toEqual([]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

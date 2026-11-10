#!/usr/bin/env node
// Stand-in for the `opencode` CLI under CEZ_DRY_RUN=1 (#1898): `--version`, `models` and
// `serve` (the 1.x HTTP + SSE API: one session, one scripted turn per prompt).
import { createServer } from 'node:http';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('0.0.0-mock\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stdout.write('mock/mock-model\n');
  process.exit(0);
}

const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));
const SESSION_ID = 'ses_mock_dry_run';

let sse = null;
let turn = 0;
const send = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  if (req.method === 'GET' && url === `/session/${SESSION_ID}`) {
    json(res, { id: SESSION_ID, title: 'cezar task' });
    return;
  }
  if (req.method === 'GET' && url.startsWith('/session/')) {
    json(res, { name: 'NotFoundError', data: { message: 'Session not found' } }, 404);
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/session') {
      json(res, { id: SESSION_ID, title: 'cezar task' });
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message`) {
      turn += 1;
      let text = '';
      try {
        text = (JSON.parse(body).parts ?? []).map((part) => part.text ?? '').join('\n');
      } catch {
        // An unreadable prompt still gets a turn.
      }
      const info = {
        id: `msg_mock_${turn}`,
        sessionID: SESSION_ID,
        role: 'assistant',
        time: { created: Date.now() },
        modelID: 'mock-model',
        providerID: 'mock',
        mode: 'build',
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      send({ type: 'message.updated', properties: { info } });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_mock_${turn}`,
            messageID: info.id,
            sessionID: SESSION_ID,
            type: 'text',
            text: `Investigating: ${text}`,
            time: { start: Date.now(), end: Date.now() },
          },
        },
      });
      json(res, { info, parts: [] });
      setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 20);
      return;
    }
    json(res, {});
  });
});

server.listen(port, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${server.address().port}`);
});
process.on('SIGTERM', () => process.exit(0));

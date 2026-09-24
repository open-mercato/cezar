#!/usr/bin/env node
// Test-only mock of `opencode serve` — speaks just enough of the HTTP+SSE
// API (§4 of agent-event-protocols.md) for the runner wiring test in
// `opencode-ui-mapper.test.ts`: POST /session, GET /event (SSE bus), one
// scripted prompt turn. Deliberately reproduces the real server's ordering
// quirk that motivates the v2 turn-end fix: the HTTP prompt response
// resolves BEFORE the final SSE parts and the `session.idle` — so a correct
// v2 stream must take `turn.completed` from `session.idle`, not from the
// HTTP response.
//
// Four scripts, selected by a marker in the prompt text, so the #897 shapes
// are reproducible without waiting five real minutes:
//   (default)     the ordering quirk above — respond, then stream, then idle.
//   `#drop-post`  destroy the message POST's socket mid-turn WITHOUT a
//                 response, keep streaming parts, send `session.idle` later.
//                 This is what undici's 300 s headersTimeout/bodyTimeout did to
//                 a long turn, from the client's point of view: the request is
//                 gone while the session is still working.
//   `#no-idle`    respond and stream normally, but never send `session.idle` —
//                 a server whose turn boundary the runner has to synthesize.
//   `#drop-then-die` destroy the message POST's socket AND then close the event
//                 bus: the drop was real, and the runner has to say so.
// `MOCK_NO_EVENT_BUS=1` in the environment makes `GET /event` 404 instead, for
// the no-event-bus fallback.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));

const SESSION_ID = 'ses_mock_1';
const MESSAGE_ID = 'msg_mock_1';

/** Turn 1 keeps the original ids (the golden wiring test pins them); later
 *  turns get their own message and part ids, as a real server would. */
let turn = 0;
const suffix = () => (turn <= 1 ? '' : `_t${turn}`);
const messageId = () => `${MESSAGE_ID}${suffix()}`;

let sse = null;
const send = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};
const info = (extra) => ({
  id: messageId(),
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 1760000000000 },
  modelID: 'mock-model',
  providerID: 'mock',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/event')) {
    if (process.env.MOCK_NO_EVENT_BUS === '1') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no event bus');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: SESSION_ID, title: 'cezar task' }));
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message`) {
      turn += 1;
      const MESSAGE_ID = messageId();
      const promptText = (() => {
        try {
          return JSON.parse(body).parts.map((p) => p.text ?? '').join('\n');
        } catch {
          return '';
        }
      })();
      const script = promptText.includes('#drop-then-die')
        ? 'drop-then-die'
        : promptText.includes('#drop-post')
          ? 'drop-post'
          : promptText.includes('#no-idle')
            ? 'no-idle'
            : 'default';

      // The other half of the #897 shape: the POST drops AND the session is
      // really gone. Swallowing the drop must not swallow this.
      if (script === 'drop-then-die') {
        res.destroy();
        setTimeout(() => {
          if (sse) sse.end();
          sse = null;
        }, 40);
        return;
      }

      // #897: the request vanishes mid-turn while the session keeps working —
      // exactly what undici's 300 s cut looked like from the runner's side.
      if (script === 'drop-post') {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: `prt_drop_before${suffix()}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Watching CI.', time: { start: 1760000000100, end: 1760000000200 } },
          },
        });
        res.destroy();
        setTimeout(() => {
          send({
            type: 'message.part.updated',
            properties: {
              part: {
                id: `prt_drop_after${suffix()}`,
                messageID: MESSAGE_ID,
                sessionID: SESSION_ID,
                type: 'text',
                text: 'Still working after the drop.',
                time: { start: 1760000000300, end: 1760000000400 },
              },
            },
          });
        }, 40);
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 120);
        return;
      }

      send({ type: 'message.updated', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: { id: `prt_mock_t1${suffix()}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Checking the working tree.' },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_mock_c1${suffix()}`,
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'pending', input: { command: 'git status --short' }, raw: '{}' },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_mock_c1${suffix()}`,
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'git status --short' }, title: 'git status --short', time: { start: 1760000000100 } },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_mock_c1${suffix()}`,
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'git status --short' },
              output: ' M src/example.ts\n',
              title: 'git status --short',
              metadata: { exit: 0 },
              time: { start: 1760000000100, end: 1760000000400 },
            },
          },
        },
      });
      send({
        type: 'message.updated',
        properties: {
          info: info({ cost: 0.0021, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }),
        },
      });
      // Respond to the prompt POST now — BEFORE the final text part and the
      // idle signal, like the real server under streaming load.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ info: info({ cost: 0.0021 }), parts: [] }));
      setTimeout(() => {
        send({
          type: 'message.part.updated',
          properties: {
            part: {
              id: `prt_mock_t2${suffix()}`,
              messageID: MESSAGE_ID,
              sessionID: SESSION_ID,
              type: 'text',
              text: 'Done.',
              time: { start: 1760000000500, end: 1760000000600 },
            },
          },
        });
      }, 30);
      if (script !== 'no-idle') {
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 90);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

server.listen(port, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
process.on('SIGTERM', () => process.exit(0));

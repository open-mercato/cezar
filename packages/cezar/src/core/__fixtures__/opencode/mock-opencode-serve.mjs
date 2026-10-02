#!/usr/bin/env node
// Test-only mock of `opencode serve` — speaks just enough of the 2.x HTTP+SSE
// API for the runner wiring tests (`opencode-ui-mapper.test.ts`,
// `opencode-server-runner.ts`): POST /api/session, POST /api/session/:id/prompt
// (fast admission), POST /api/experimental/session/:id/wait (the turn's long
// poll), GET /api/event (SSE bus), one scripted prompt turn per prompt. SSE
// events stay in the v1 `{type, properties}` shape — the runner's translator
// passes v1 frames through untouched, which is what keeps the golden wiring
// expectations byte-identical; the 2.x `{type, data}` reshaping is covered by
// `opencode-v2-events.test.ts` against recorded live payloads.
//
// Deliberately reproduces the real server's ordering quirk that motivates the
// v2 turn-end fix: admission answers BEFORE the final SSE parts and the
// `session.idle` — so a correct stream must take `turn.completed` from
// `session.idle`, not from the HTTP response.
//
// Four scripts, selected by a marker in the prompt text, so the #897 shapes
// are reproducible without waiting five real minutes:
//   (default)     the ordering quirk above — stream, admit, then idle later.
//   `#drop-post`  destroy the WAIT long poll's socket mid-turn WITHOUT a
//                 response, keep streaming parts, send `session.idle` later.
//                 This is what undici's 300 s headersTimeout/bodyTimeout did to
//                 a long turn, from the client's point of view: the request is
//                 gone while the session is still working.
//   `#no-idle`    stream and answer the wait normally, but never send
//                 `session.idle` — a server whose turn boundary the runner has
//                 to synthesize (grace window).
//   `#drop-then-die` destroy the WAIT long poll's socket AND then close the
//                 event bus: the drop was real, and the runner has to say so.
// `MOCK_NO_EVENT_BUS=1` in the environment makes `GET /api/event` 404 instead,
// for the no-event-bus fallback.
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

/** Turns awaiting their `wait` poll: each prompt enqueues, each wait dequeues
 *  in FIFO order — prompt #2 can reach the wire before prompt #1's wait does
 *  (the supersede path runs both concurrently). */
const waitQueue = [];

const respond = (res, payload) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

function handlePrompt(raw, res) {
  turn += 1;
  const sfx = suffix();
  const MID = messageId();
  let text = '';
  try {
    text = JSON.parse(raw).text ?? '';
  } catch {
    /* no body → default script */
  }
  const script = text.includes('#drop-then-die')
    ? 'drop-then-die'
    : text.includes('#drop-post')
      ? 'drop-post'
      : text.includes('#no-idle')
        ? 'no-idle'
        : 'default';
  waitQueue.push({ script, sfx, MID });

  const part = (id, extra) => ({
    type: 'message.part.updated',
    properties: { part: { id: `${id}${sfx}`, messageID: MID, sessionID: SESSION_ID, ...extra } },
  });

  // The other half of the #897 shape: the wait drops AND the session is
  // really gone. Swallowing the drop must not swallow this.
  if (script === 'drop-then-die') {
    respond(res, { data: {} });
    return;
  }

  // #897: the request vanishes mid-turn while the session keeps working —
  // exactly what undici's 300 s cut looked like from the runner's side.
  // The rest of this turn streams after `handleWait` destroys the socket.
  if (script === 'drop-post') {
    send({ type: 'message.updated', properties: { info: info({}) } });
    send(
      part('prt_drop_before', {
        type: 'text',
        text: 'Watching CI.',
        time: { start: 1760000000100, end: 1760000000200 },
      }),
    );
    respond(res, { data: {} });
    return;
  }

  send({ type: 'message.updated', properties: { info: info({}) } });
  send(part('prt_mock_t1', { type: 'text', text: 'Checking the working tree.' }));
  send(
    part('prt_mock_c1', {
      type: 'tool',
      callID: 'call_mock_1',
      tool: 'bash',
      state: { status: 'pending', input: { command: 'git status --short' }, raw: '{}' },
    }),
  );
  send(
    part('prt_mock_c1', {
      type: 'tool',
      callID: 'call_mock_1',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'git status --short' },
        title: 'git status --short',
        time: { start: 1760000000100 },
      },
    }),
  );
  send(
    part('prt_mock_c1', {
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
    }),
  );
  send({
    type: 'message.updated',
    properties: {
      info: info({ cost: 0.0021, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }),
    },
  });
  // Admission answers BEFORE the final text part and the idle signal, like the
  // real server under streaming load — the ordering quirk that pins
  // `turn.completed` to `session.idle` rather than the HTTP response.
  respond(res, { data: {} });
  setTimeout(
    () =>
      send(
        part('prt_mock_t2', {
          type: 'text',
          text: 'Done.',
          time: { start: 1760000000500, end: 1760000000600 },
        }),
      ),
    30,
  );
  if (script !== 'no-idle') {
    setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 90);
  }
}

function handleWait(res) {
  const entry = waitQueue.shift();
  if (!entry) {
    // Nothing in flight — the loop is idle (204, like the real endpoint).
    res.writeHead(204);
    res.end();
    return;
  }

  if (entry.script === 'drop-then-die') {
    res.destroy();
    setTimeout(() => {
      if (sse) sse.end();
      sse = null;
    }, 40);
    return;
  }

  if (entry.script === 'drop-post') {
    res.destroy();
    setTimeout(
      () =>
        send({
          type: 'message.part.updated',
          properties: {
            part: {
              id: `prt_drop_after${entry.sfx}`,
              messageID: entry.MID,
              sessionID: SESSION_ID,
              type: 'text',
              text: 'Still working after the drop.',
              time: { start: 1760000000300, end: 1760000000400 },
            },
          },
        }),
      40,
    );
    setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 120);
    return;
  }

  // default/no-idle: this response is NOT the boundary — the SSE
  // `session.idle` is (or its absence, → the runner's grace window). Answer
  // at once; the real server would answer when the loop goes idle, which the
  // runner treats identically (settle → grace re-armed by every frame).
  res.writeHead(204);
  res.end();
}

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/api/event')) {
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
    if (req.method === 'POST' && url === '/api/session') {
      respond(res, { data: { id: SESSION_ID, title: 'cezar task' } });
      return;
    }
    if (req.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(url)) {
      handlePrompt(body, res);
      return;
    }
    if (req.method === 'POST' && url.startsWith('/api/experimental/session/') && url.endsWith('/wait')) {
      handleWait(res);
      return;
    }
    if (req.method === 'POST' && url.includes('/interrupt')) {
      respond(res, { interrupted: true });
      return;
    }
    respond(res, {});
  });
});

server.listen(port, hostname, () => {
  // The runner reads the bound URL and password back from stdout, like the
  // real 2.x server (both lines land in the same instant).
  console.log(`opencode server listening on http://${hostname}:${port}`);
  console.log('server password mock-secret');
});
process.on('SIGTERM', () => process.exit(0));

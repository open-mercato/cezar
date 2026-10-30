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
//   `#retry-limit` hold the POST open and report a `session.status` retry with a
//                 spent-quota `action` and `next` hours away (`MOCK_RETRY_NEXT` pins it),
//                 as a spent free tier does. `MOCK_RETRY_STATUS` (JSON) replaces the status
//                 and `MOCK_RETRY_SESSION` the session it is reported for.
//   `#retry-soon` report a retry due in 1 s with no `action`, then finish normally.
//   `#permission <path>` ask `external_directory` for <path> and, like the
//                 real server, finish the turn only once the prompt is answered;
//                 the final text names the reply.
//   `#question` ask via the native `question` tool (`question.asked`) and, like the
//                 real server, finish the turn only once `POST /question/:id/reply`
//                 (final text echoes the answers) or `/reject` arrives.
//   `#question-free` the same, but with a free-text question that has no options.
// `MOCK_LEGACY_PERMISSION=1` serves only the pre-rework session-scoped reply route.
// `MOCK_NO_EVENT_BUS=1` in the environment makes `GET /event` 404 instead, for
// the no-event-bus fallback.
// `MOCK_START=silent` never prints the URL line; `MOCK_START=stderr` prints it on
// stderr. `MOCK_PATH_DIR` overrides the `directory` `GET /path` reports.
// `MOCK_API=v2` answers every non-`/api/` POST with 405, as OpenCode 2.x does.
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
/** The one prompt a turn is blocked on, and what answering it does. A single
 *  slot compared by id — never a lookup keyed by the request URL. */
let pendingPermission = null;
let pendingQuestion = null;
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
  if (req.method === 'GET' && url === '/path') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ directory: process.env.MOCK_PATH_DIR ?? process.cwd() }));
    return;
  }
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
    // OpenCode 2.x serves its API under `/api` and answers the 1.x routes with 405.
    if (process.env.MOCK_API === 'v2' && !url.startsWith('/api/')) {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: SESSION_ID, title: 'cezar task' }));
      return;
    }
    // The current reply route, or — under `MOCK_LEGACY_PERMISSION=1`, a server
    // from before the permission rework — only the session-scoped one.
    const legacy = process.env.MOCK_LEGACY_PERMISSION === '1';
    const permissionReply = legacy
      ? url.match(new RegExp(`^/session/${SESSION_ID}/permissions/([^/]+)$`))
      : url.match(/^\/permission\/([^/]+)\/reply$/);
    if (legacy && /^\/permission\//.test(url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.method === 'POST' && permissionReply) {
      const pending = pendingPermission?.id === permissionReply[1] ? pendingPermission : null;
      let reply;
      try {
        const parsed = JSON.parse(body);
        reply = legacy ? parsed.response : parsed.reply;
      } catch {
        reply = undefined;
      }
      if (!pending || typeof reply !== 'string') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      pendingPermission = null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('true');
      pending.finish(reply);
      return;
    }
    const questionRoute = url.match(/^\/question\/([^/]+)\/(reply|reject)$/);
    if (req.method === 'POST' && questionRoute) {
      const pending = pendingQuestion?.id === questionRoute[1] ? pendingQuestion : null;
      if (!pending) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      pendingQuestion = null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('true');
      pending.finish(questionRoute[2] === 'reject' ? 'rejected' : `answered ${body}`);
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

      if (promptText.includes('#http-error')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'InternalError', data: { message: 'Provider rejected the configured model' } }));
        return;
      }

      if (promptText.includes('#question')) {
        const id = `que_mock_${turn}`;
        pendingQuestion = { id, finish: (what) => {
          send({
            type: 'message.part.updated',
            properties: {
              part: { id: `prt_que${suffix()}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: `question ${what}`, time: { start: 1, end: 2 } },
            },
          });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 20);
        } };
        send({ type: 'message.updated', properties: { info: info({}) } });
        const options = promptText.includes('#question-free') ? [] : [
          { label: 'Approach A', description: 'the quick one' },
          { label: 'Approach B', description: 'the thorough one' },
        ];
        send({
          type: 'question.asked',
          properties: { id, sessionID: SESSION_ID, questions: [{ question: 'Which approach should I use?', header: 'Approach', options }] },
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ info: info({}), parts: [] }));
        return;
      }

      const asked = promptText.match(/#permission (\S+)/);
      if (asked) {
        const id = `per_mock_${turn}`;
        pendingPermission = { id, finish: (reply) => {
          send({
            type: 'message.part.updated',
            properties: {
              part: { id: `prt_perm${suffix()}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: `permission ${reply}`, time: { start: 1, end: 2 } },
            },
          });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 20);
        } };
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({
          type: 'permission.asked',
          properties: {
            id,
            sessionID: SESSION_ID,
            permission: 'external_directory',
            patterns: [`${asked[1].replace(/\/[^/]*$/, '')}/*`],
            metadata: { filepath: asked[1] },
            always: [],
          },
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ info: info({}), parts: [] }));
        return;
      }

      const retryStatus = (extra) =>
        send({
          type: 'session.status',
          properties: { sessionID: process.env.MOCK_RETRY_SESSION ?? SESSION_ID, status: { type: 'retry', attempt: 1, ...extra } },
        });
      if (promptText.includes('#retry-limit')) {
        retryStatus(process.env.MOCK_RETRY_STATUS ? JSON.parse(process.env.MOCK_RETRY_STATUS) : {
          message: 'Free usage exceeded, subscribe to Go',
          action: { reason: 'free_tier_limit', provider: 'opencode', title: 'Free limit reached', message: 'Subscribe', label: 'subscribe' },
          next: Number(process.env.MOCK_RETRY_NEXT) || Date.now() + 3 * 60 * 60_000,
        });
        return; // the POST stays open, like the real server's retry loop
      }
      if (promptText.includes('#retry-soon')) retryStatus({ message: 'Overloaded', next: Date.now() + 1_000 });

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
  const line = `opencode server listening on http://${hostname}:${server.address().port}`;
  if (process.env.MOCK_START === 'stderr') console.error(line);
  else if (process.env.MOCK_START !== 'silent') console.log(line);
});
process.on('SIGTERM', () => process.exit(0));

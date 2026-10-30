#!/usr/bin/env node
// Strict, offline OpenCode 2.0.19 API fixture. No provider or model is contacted.
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const sessionID = 'ses_v2_mock';
const password = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD;
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
let stream;
let turn = 0;
let busy = false;
let dropWait = false;
const waiters = [];
const emit = (type, data) => stream?.write(`event: ${type}\ndata: ${JSON.stringify({
  id: `evt_${Date.now()}`, created: Date.now(), type, data: { sessionID, ...data },
})}\n\n`);
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const idle = (sendIdle = true) => {
  busy = false;
  if (sendIdle) emit('session.idle', {});
  for (const res of waiters.splice(0)) { res.writeHead(204); res.end(); }
};
const server = createServer((req, res) => {
  if (!password || req.headers.authorization !== authorization) return json(res, { error: 'Unauthorized' }, 401);
  const path = req.url;
  if (req.method === 'GET' && path === '/api/info') {
    if (process.env.MOCK_V2_PROBE_UNAUTHORIZED === '1') return json(res, { error: 'Unauthorized' }, 401);
    return json(res, { version: '2.0.19', pid: process.pid, urls: [] });
  }
  if (req.method === 'GET' && path === '/api/event') {
    if (process.env.MOCK_NO_EVENT_BUS === '1') return json(res, {}, 404);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    stream = res;
    emit('server.connected', {});
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let data;
    try { data = body ? JSON.parse(body) : undefined; } catch { return json(res, {}, 400); }
    if (req.method === 'POST' && path === '/api/session') {
      if (!data?.location?.directory || realpathSync(data.location.directory) !== process.cwd()
        || data.title !== 'cezar task'
        || JSON.stringify(data.permissions) !== JSON.stringify([{ action: '*', resource: '*', effect: 'allow' }])
        || (data.model && (data.model.id !== 'mock-model' || data.model.providerID !== 'mock' || data.model.variant !== 'high'))) {
        return json(res, { error: 'invalid V2 session shape' }, 400);
      }
      return json(res, { data: { id: sessionID, location: data.location } });
    }
    if (req.method === 'POST' && path === `/api/experimental/session/${sessionID}/wait`) {
      if (dropWait) { req.socket.destroy(); return; }
      if (busy) waiters.push(res);
      else { res.writeHead(204); res.end(); }
      return;
    }
    if (req.method === 'POST' && path === `/api/session/${sessionID}/interrupt`) {
      idle();
      return json(res, { interrupted: true });
    }
    if (req.method === 'POST' && path === `/api/session/${sessionID}/prompt`) {
      if (typeof data?.text !== 'string' || Object.keys(data).some((key) => key !== 'text')) {
        return json(res, { error: 'invalid V2 prompt shape' }, 400);
      }
      if (!stream) return json(res, { error: 'event stream must connect first' }, 409);
      turn++;
      busy = true;
      dropWait = data.text.includes('#wait-drop');
      const assistantMessageID = `msg_v2_${turn}`;
      const common = { assistantMessageID };
      json(res, { data: { id: `inb_${turn}`, sessionID, type: 'user' } }); // acknowledgement, NOT completion
      emit('session.execution.started', {});
      emit('session.step.started', { ...common, agent: 'build', model: { id: 'mock-model', providerID: 'mock' }, started: Date.now() });
      if (data.text.includes('#stream-loss')) {
        setTimeout(() => { stream.end(); stream = undefined; }, 20);
        return; // wait hangs unless the runner handles the lost event bus
      }
      if (data.text.includes('#error')) {
        emit('session.execution.failed', { error: { type: 'ProviderError', message: 'invalid API key', status: 401 } });
        idle();
        return;
      }
      const delay = data.text.includes('#quiet') ? 5300 : 30;
      setTimeout(() => {
        emit('session.text.started', { ...common, ordinal: 0 });
        emit('session.text.delta', { ...common, ordinal: 0, delta: `Turn ${turn}: ` });
        emit('session.text.delta', { ...common, ordinal: 0, delta: data.text });
        emit('session.text.ended', { ...common, ordinal: 0, text: `Turn ${turn}: ${data.text}` });
        emit('session.tool.input.started', { ...common, id: `call_${turn}`, name: 'shell' });
        emit('session.tool.called', { ...common, id: `call_${turn}`, input: { command: 'git status' }, executed: true });
        emit('session.tool.success', { ...common, id: `call_${turn}`, content: [{ type: 'text', text: 'clean' }], executed: true });
        emit('session.step.ended', { ...common, finish: 'stop', cost: 0.01, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } });
        emit('session.execution.succeeded', {});
        idle(!data.text.includes('#no-idle'));
      }, delay);
      return;
    }
    // A V1 path must never work accidentally against V2's web fallback.
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>not an API route</html>');
  });
});
server.listen(port, '127.0.0.1', () => console.log(`OpenCode http://127.0.0.1:${port}`));
process.on('SIGTERM', () => process.exit(0));

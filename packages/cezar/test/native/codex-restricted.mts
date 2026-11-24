// Explicit native validation; never included in npm test. No real credentials or external API calls.
// TMPDIR=/tmp node --import tsx packages/cezar/test/native/codex-restricted.mts
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServerRunner } from '../../src/core/codex-app-server-runner.ts';
import type { AgentRunSpec, AgentSession } from '../../src/core/agent-runner.ts';

const root = mkdtempSync(join(tmpdir(), 'cez-native-restricted-'));
const cwd = join(root, 'repo'); const native = join(root, 'native');
for (const dir of [cwd, native, join(root, 'gh')]) mkdirSync(dir);
const secret = `ACTUAL_FILE_CONTENT_${randomUUID()}`;
writeFileSync(join(cwd, 'a.txt'), secret);
const marker = join(cwd, 'FORBIDDEN');
type Step = { name: string; args: unknown; custom?: boolean };
let steps: Step[] = [];
let counter = 0;
let outputs: string[] = [];
let surfaces: string[][] = [];
const sessions: AgentSession[] = [];
const server = createServer((req, res) => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    if (!req.url?.includes('/responses')) { res.writeHead(404); res.end('{}'); return; }
    const body = JSON.parse(text);
    surfaces.push((body.tools ?? []).map((tool: {name?: string; type: string}) => tool.name ?? tool.type));
    for (const item of body.input ?? []) if (/function_call_output|custom_tool_call_output/.test(item.type)) outputs.push(typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (value: {type: string; [key: string]: unknown}) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    const id = `resp_${++counter}`;
    event({ type: 'response.created', response: { id } });
    const step = steps.shift();
    if (step) event({ type: 'response.output_item.done', item: step.custom
      ? { type: 'custom_tool_call', name: step.name, input: step.args, call_id: `call_${counter}` }
      : { type: 'function_call', name: step.name, arguments: JSON.stringify(step.args), call_id: `call_${counter}` } });
    else event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${counter}`, content: [{ type: 'output_text', text: 'DONE' }] } });
    event({ type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert(address && typeof address !== 'string');
writeFileSync(join(native, 'config.toml'), `model="gpt-5.5"\nmodel_provider="stub"\n[model_providers.stub]\nname="Local test"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nenv_key="STUB_KEY"\nrequires_openai_auth=false\n`);
const oldHome = process.env.CEZ_HOME;
process.env.CEZ_HOME = join(root, 'cezar');
const runner = new CodexAppServerRunner({ bin: process.argv[2] ?? 'codex' });
const spec: AgentRunSpec = { cwd, model: 'gpt-5.5', timeoutMs: 45_000, userPrompt: 'Exercise the test tool calls.', allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'],
  env: { HOME: root, CODEX_HOME: native, GH_CONFIG_DIR: join(root, 'gh'), STUB_KEY: 'FAKE', OPENAI_API_KEY: '', CODEX_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } };
const deadline = setTimeout(() => { for (const session of sessions) session.end(); }, 90_000);
try {
  steps = [
    { name: 'exec_command', args: { cmd: `touch ${marker}`, login: false } },
    { name: 'apply_patch', args: `*** Begin Patch\n*** Add File: ${marker}\n+BAD\n*** End Patch`, custom: true },
    { name: 'view_image', args: { path: '/etc/passwd' } },
    { name: 'cezar_read', args: { tool: 'Bash', command: `git status; touch ${marker}` } },
    { name: 'cezar_read', args: { tool: 'Read', path: 'a.txt' } },
  ];
  const first = runner.startSession(spec, undefined, { autoEndAfterFirstTurn: true }); sessions.push(first);
  const result = await first.result;
  assert.equal(result.text, 'DONE');
  assert(outputs.some(text => text.includes(secret)), 'the real broker must supply actual file content');
  assert(outputs.some(text => text.includes('No usable execution environment') || text.includes('unsupported call')), 'native execution must be refused');
  assert.equal(existsSync(marker), false);
  console.log('PASS native: disabled shell/apply_patch/view_image; denied broker mutation; real file read');

  // Native tool definitions must survive reopening an isolated thread, with an empty environment on the turn.
  outputs = []; surfaces = []; steps = [{ name: 'cezar_read', args: { tool: 'Read', path: 'a.txt' } }];
  const resumed = runner.startSession({ ...spec, resume: true, sessionId: result.sessionId }, undefined, { autoEndAfterFirstTurn: true }); sessions.push(resumed);
  await resumed.result;
  assert(outputs.some(text => text.includes(secret)), 'dynamic tool definitions must persist across resume');
  assert(surfaces.some(tools => tools.includes('cezar_read')), 'resumed thread must offer the broker');
  assert.equal(existsSync(marker), false);
  console.log('PASS native: isolated resume retains broker and no execution environment');

  outputs = []; steps = [{ name: 'cezar_read', args: { tool: 'Read', path: 'a.txt' } }];
  const narrowed = runner.startSession({ ...spec, allowedTools: [], bashAllowlist: undefined, resume: true, sessionId: result.sessionId }, undefined, { autoEndAfterFirstTurn: true }); sessions.push(narrowed);
  await narrowed.result;
  assert(outputs.at(-1)?.includes('not granted'), 'retained dynamic definitions must not widen a narrowed grant');
  console.log('PASS native: resumed thread enforces a narrowed empty tool grant');

  outputs = []; steps = [{ name: 'cezar_read', args: { tool: 'Read', path: 'a.txt' } }];
  let heldId: string | undefined;
  let turnDone!: () => void;
  const heldTurn = new Promise<void>(done => { turnDone = done; });
  const held = runner.startSession(spec, event => {
    if (event.type === 'session') heldId = event.sessionId;
    if (event.type === 'turn-end') turnDone();
  }); sessions.push(held);
  await heldTurn;
  assert(heldId);
  outputs = []; steps = [{ name: 'cezar_read', args: { tool: 'Read', path: 'a.txt' } }];
  const fork = runner.startSession({ ...spec, resume: true, sessionId: heldId }, undefined, { autoEndAfterFirstTurn: true }); sessions.push(fork);
  const forkResult = await fork.result;
  assert.notEqual(forkResult.sessionId, heldId, 'a live writer should force the safe fork path');
  assert(outputs.at(-1)?.includes(secret), 'forked history must retain the broker definition');
  assert.equal(existsSync(marker), false);
  held.end(); await held.result;
  console.log('PASS native: writer-lock fork retains broker and restricted execution');

} finally {
  clearTimeout(deadline);
  for (const session of sessions) session.end();
  await Promise.allSettled(sessions.map(session => session.result));
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  if (oldHome === undefined) delete process.env.CEZ_HOME; else process.env.CEZ_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
}

// ACP capture harness: drives `gemini --acp` through a scripted scenario and logs every
// wire line (direction-tagged) to an NDJSON transcript. Keys are redacted on write.
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , outFile, scenario, cwd, ...extra] = process.argv;
writeFileSync(outFile, '');
const SECRETS = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].filter((s) => s && s.length > 8);
const redact = (s) => SECRETS.reduce((acc, k) => acc.split(k).join('<REDACTED>'), s);
const T0 = Date.now();
const log = (dir, line) => appendFileSync(outFile, redact(JSON.stringify({ dir, ms: Date.now() - T0, frame: safeParse(line) ?? line })) + "\n");
function safeParse(l) { try { return JSON.parse(l); } catch { return undefined; } }

const args = ['--acp', ...extra];
const child = spawn(process.env.GEMINI_BIN ?? 'gemini', args, { cwd, env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
let nextId = 0;
const pending = new Map();
const handlers = [];
function send(obj) { const line = JSON.stringify(obj); log('out', line); child.stdin.write(line + '\n'); }
function request(method, params) { const id = nextId++; send({ jsonrpc: '2.0', id, method, params }); return new Promise((res) => pending.set(id, res)); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
createInterface({ input: child.stdout }).on('line', (line) => {
  log('in', line);
  const m = safeParse(line); if (!m) return;
  if (m.id !== undefined && m.method === undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.kind === 'allow_always') ?? m.params.options?.[0];
    send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } });
    return;
  }
  if (m.id !== undefined && m.method) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }); return; }
  for (const h of handlers) h(m);
});
const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
const timeout = setTimeout(() => { appendFileSync(outFile, JSON.stringify({ dir: 'meta', timeout: true }) + '\n'); child.kill('SIGKILL'); }, 300000);

const init = await Promise.race([request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), exited.then((e) => ({ exited: e }))]);
if (init.exited) { finish(init.exited); }
const text = (t) => [{ type: 'text', text: t }];
const scenarios = {
  async main() {
    const s = await request('session/new', { cwd, mcpServers: [] });
    if (s.error) return;
    const sid = s.result.sessionId;
    await request('session/prompt', { sessionId: sid, prompt: text(process.env.PROMPT1) });
    if (process.env.PROMPT2) await request('session/prompt', { sessionId: sid, prompt: text(process.env.PROMPT2) });
    writeFileSync(outFile + '.sid', sid);
  },
  async cancel() {
    const s = await request('session/new', { cwd, mcpServers: [] });
    const sid = s.result.sessionId;
    const p = request('session/prompt', { sessionId: sid, prompt: text(process.env.PROMPT1) });
    await new Promise((r) => setTimeout(r, Number(process.env.CANCEL_AFTER_MS ?? 4000)));
    notify('session/cancel', { sessionId: sid });
    await p;
    await request('session/prompt', { sessionId: sid, prompt: text('Reply with the single word STILL-HERE.') });
  },
  async load() {
    const sid = process.env.LOAD_SID;
    const r = await request('session/load', { sessionId: sid, cwd, mcpServers: [] });
    if (r.error) return;
    await request('session/prompt', { sessionId: sid, prompt: text(process.env.PROMPT1) });
  },
  async controls() {
    const s = await request('session/new', { cwd, mcpServers: [] });
    const sid = s.result.sessionId;
    await request('session/set_mode', { sessionId: sid, modeId: 'yolo' });
    await request('session/set_model', { sessionId: sid, modelId: 'gemini-3.1-flash-lite' });
    await request('session/unstable_setSessionModel', { sessionId: sid, modelId: 'gemini-3.1-flash-lite' });
    await request('session/cancel_nothing', { sessionId: sid });
    await request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd, mcpServers: [] });
  },
  async newonly() { await request('session/new', { cwd, mcpServers: [] }); },
};
try { await scenarios[scenario](); } catch (e) { appendFileSync(outFile, JSON.stringify({ dir: 'meta', harnessError: String(e) }) + '\n'); }
child.stdin.end();
finish(await Promise.race([exited, new Promise((r) => setTimeout(() => { child.kill('SIGTERM'); r(exited); }, 5000))]));
async function finish(e) {
  const ex = await e;
  clearTimeout(timeout);
  appendFileSync(outFile, redact(JSON.stringify({ dir: 'meta', exit: ex, stderrTail: stderr.slice(-1500) })) + '\n');
  process.exit(0);
}

#!/usr/bin/env node
// A tool-execution adversary. The real runner must refuse mutations before this fixture can act.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse } from 'smol-toml';
const cwd = process.cwd();
const mode = existsSync(join(cwd, 'mode')) ? readFileSync(join(cwd, 'mode'), 'utf8').trim() : '';
const configPath = join(process.env.CODEX_HOME, 'config.toml');
const config = parse(readFileSync(configPath, 'utf8'));
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const th = mode === 'lock' ? 'forked' : 'restricted';
let results = [];
let pending = 0;
let queue = [];
let turn;
function next() {
  const request = queue.shift();
  if (request) { pending = request.id; send(request); return; }
  send({ method: 'item/completed', params: { threadId: th, turnId: turn, item: { type: 'agentMessage', id: 'answer', text: JSON.stringify(results) } } });
  send({ method: 'turn/completed', params: { threadId: th, turn: { id: turn, status: 'completed' } } });
}
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  appendFileSync(join(cwd, 'rpc.ndjson'), JSON.stringify(msg) + '\n');
  if (!msg.method) {
    results.push(msg);
    if (msg.id === pending && msg.result?.decision?.startsWith?.('accept')) writeFileSync(join(cwd, 'FORBIDDEN'), 'executed');
    next(); continue;
  }
  switch (msg.method) {
    case 'initialize': send({ id: msg.id, result: { userAgent: mode === 'version' ? 'cezar/99.0.0' : 'cezar/0.169.0 mock', codexHome: process.env.CODEX_HOME, platformOs: 'macos' } }); break;
    case 'initialized': break;
    case 'config/read': {
      const effective = { apps: null, plugins: {}, mcp_servers: {}, hooks: null, ...config };
      if (mode === 'flags') effective.features.shell_tool = true;
      if (mode === 'apps') effective.features.apps = true;
      const layers = [{ name: { type: 'user', file: configPath }, config }];
      if (mode === 'layer') layers.push({ name: { type: 'futureLayer' }, config: {} });
      send({ id: msg.id, result: { config: effective, layers } }); break;
    }
    case 'configRequirements/read': send({ id: msg.id, result: { requirements: mode === 'requirements' ? {} : null } }); break;
    case 'hooks/list': send({ id: msg.id, result: { data: [{ hooks: mode === 'hooks' ? [{}] : [], errors: [], warnings: [] }] } }); break;
    case 'mcpServerStatus/list': send({ id: msg.id, result: { data: mode === 'mcp' && msg.params?.threadId ? [{ name: 'evil' }] : [], nextCursor: null } }); break;
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      if (mode === 'lock' && msg.method === 'thread/resume') send({ id: msg.id, error: { code: -1, message: 'already has an active writer' } });
      else send({ id: msg.id, result: { thread: { id: th }, cwd, approvalPolicy: 'never', sandbox: { type: mode === 'sandbox' ? 'dangerFullAccess' : 'readOnly', networkAccess: false } } });
      break;
    case 'turn/start': {
      results = [];
      turn = 'turn_' + msg.id;
      send({ id: msg.id, result: { turn: { id: turn } } });
      send({ method: 'turn/started', params: { threadId: th, turn: { id: turn } } });
      const dynamic = (id, arguments_, extra = {}) => ({ id, method: 'item/tool/call', params: { threadId: th, turnId: turn, callId: String(id), tool: 'cezar_read', arguments: arguments_, ...extra } });
      queue = [
        ...['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'future/unsafe'].map((method, n) => ({ id: 200 + n, method, params: { threadId: th, command: 'touch FORBIDDEN' } })),
        dynamic(210, { tool: 'Write', path: 'FORBIDDEN', content: 'mutated' }),
        dynamic(211, { tool: 'Bash', command: 'touch FORBIDDEN' }),
        dynamic(212, { tool: 'Bash', command: 'gh pr merge 1' }),
        dynamic(213, { tool: 'Read', path: 'a.txt' }, { tool: 'mcp__evil' }),
        dynamic(214, { tool: 'Read', path: 'a.txt' }, { threadId: 'foreign' }),
        dynamic(215, { tool: 'Read', path: 'a.txt' }),
      ];
      next(); break;
    }
    default: if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
}

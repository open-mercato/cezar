#!/usr/bin/env node
// Stand-in for the `codex` CLI under CEZ_DRY_RUN=1 (#1898): `--version`, `login status` and
// `app-server` (initialize, model/list, thread/*, one scripted turn per turn/start).
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
const isolated = process.argv.includes('--strict-config');
const isolatedConfig = () => isolated ? parse(readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8')) : {};

const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  process.stdout.write('codex-cli 0.0.0 (mock, CEZ_DRY_RUN=1)\n');
  process.exit(0);
}
if (args === 'login status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}

const threadId = 'th_mock_dry_run';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const MODELS = [
  {
    model: 'mock-codex',
    displayName: 'Mock Codex',
    description: 'CEZ_DRY_RUN=1 mock model',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  },
];
let turnSeq = 0;

function runTurn(id, text) {
  turnSeq += 1;
  const turnId = `turn_mock_${turnSeq}`;
  const verdict = /mock:verdict=([A-Za-z0-9_-]+)/.exec(text)?.[1]
    ?? (text.includes('You did not end with a verdict.') ? /CEZ:VERDICT ([A-Za-z0-9_-]+)/.exec(text)?.[1] : undefined);
  const reply = `Investigating: ${text}${verdict ? `\n\nCEZ:VERDICT ${verdict}` : ''}`;
  send({ id, result: { turn: { id: turnId } } });
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  send({ method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg_${turnId}`, text: '' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `msg_${turnId}`, delta: reply } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg_${turnId}`, text: reply } } });
  const usage = { totalTokens: 15, inputTokens: 10, outputTokens: 5 };
  send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: usage, last: usage } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.id === undefined || !msg.method) continue;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: isolated ? { userAgent: 'cezar/0.169.0 (dry-run mock)', codexHome: process.env.CODEX_HOME, platformOs: process.platform === 'darwin' ? 'macos' : 'linux' } : { userAgent: 'mock-codex/0.0.0' } });
  } else if (msg.method === 'config/read') {
    const config = isolatedConfig();
    send({ id: msg.id, result: { config: { apps: null, plugins: {}, mcp_servers: {}, hooks: null, ...config }, layers: [{ name: { type: 'user', file: join(process.env.CODEX_HOME, 'config.toml') }, config }] } });
  } else if (msg.method === 'configRequirements/read') {
    send({ id: msg.id, result: { requirements: null } });
  } else if (msg.method === 'hooks/list') {
    send({ id: msg.id, result: { data: [{ hooks: [], errors: [], warnings: [] }] } });
  } else if (msg.method === 'mcpServerStatus/list') {
    send({ id: msg.id, result: { data: [], nextCursor: null } });
  } else if (msg.method === 'model/list') {
    send({ id: msg.id, result: { data: MODELS, nextCursor: null } });
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume' || msg.method === 'thread/fork') {
    send({ id: msg.id, result: { thread: { id: msg.method === 'thread/start' ? threadId : msg.params?.threadId ?? threadId }, ...(isolated ? { approvalPolicy: 'never', cwd: process.cwd(), sandbox: { type: 'readOnly', networkAccess: false } } : {}) } });
  } else if (msg.method === 'turn/start') {
    const text = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    runTurn(msg.id, text);
  } else {
    // Every turn completes at once, so turn/interrupt, turn/steer and the rest just ack.
    send({ id: msg.id, result: {} });
  }
}

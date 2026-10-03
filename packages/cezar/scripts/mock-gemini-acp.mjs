#!/usr/bin/env node
// Mock `gemini --acp` for CEZ_DRY_RUN=1 and the runner tests (#581). Every frame mirrors a shape
// captured from the real Gemini CLI 0.60.0 in src/core/__fixtures__/gemini/ — see its README.
//
// Test hooks (env):
//   CEZ_MOCK_GEMINI_ARGS_FILE   write {argv, trust} there on start
//   CEZ_MOCK_GEMINI_EXIT        exit with this code before answering anything (41 auth, 52 config, …)
//   CEZ_MOCK_GEMINI_AUTH_FAIL=1 fail session/new like a Google-login-only account (UNSUPPORTED_CLIENT)
//   CEZ_MOCK_GEMINI_PERMISSION=1 ask session/request_permission before the shell tool
//   CEZ_MOCK_GEMINI_SLOW=1      stream a long thought and wait for session/cancel
//   CEZ_MOCK_GEMINI_DIE_MID_TURN=1 exit(1) in the middle of the first prompt
//   CEZ_MOCK_GEMINI_NO_LOAD=1   advertise loadSession: false
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const env = process.env;
const trusted = env.GEMINI_CLI_TRUST_WORKSPACE === 'true';
if (env.CEZ_MOCK_GEMINI_ARGS_FILE) {
  writeFileSync(env.CEZ_MOCK_GEMINI_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), trust: trusted }));
}
if (env.CEZ_MOCK_GEMINI_EXIT) process.exit(Number(env.CEZ_MOCK_GEMINI_EXIT));
// The real CLI exits 55 in a folder it has not been told to trust.
if (!trusted) {
  process.stderr.write('Gemini CLI is not running in a trusted directory.\n');
  process.exit(55);
}

const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const argModel = (() => {
  const i = process.argv.indexOf('--model');
  return i >= 0 ? process.argv[i + 1] : 'gemini-3-flash-preview';
})();
const sessionResult = (sessionId) => ({
  ...(sessionId ? { sessionId } : {}),
  modes: {
    availableModes: [
      { id: 'default', name: 'Default', description: 'Prompts for approval' },
      { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
    ],
    currentModeId: 'yolo',
  },
  models: { availableModels: [{ modelId: argModel, name: argModel }], currentModelId: argModel },
});
const commands = (sessionId) =>
  update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Show available commands' }] });

let nextOutboundId = 0;
const waiting = new Map(); // our outbound request id -> resolver
const cancelled = new Set();
let promptCount = 0;

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  promptCount += 1;
  if (env.CEZ_MOCK_GEMINI_SLOW === '1') {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Thinking hard**\nThis will take a while.' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'run_shell_command__call_1', status: 'in_progress', title: 'sleep 600', content: [], locations: [], kind: 'execute' });
    while (!cancelled.has(sessionId)) await new Promise((r) => setTimeout(r, 20));
    cancelled.delete(sessionId);
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Planning the change**\nRead the file first.' } });
  if (env.CEZ_MOCK_GEMINI_DIE_MID_TURN === '1') process.exit(1);
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `read_file__call_${promptCount}1`, status: 'in_progress', title: 'README.md', content: [], locations: [{ path: 'README.md' }], kind: 'read' });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `read_file__call_${promptCount}1`, status: 'completed', title: 'README.md', content: [], locations: [{ path: 'README.md' }], kind: 'read' });
  const shellId = `run_shell_command__call_${promptCount}2`;
  const shell = { toolCallId: shellId, title: 'echo mock', content: [], locations: [], kind: 'execute' };
  if (env.CEZ_MOCK_GEMINI_PERMISSION === '1') {
    const reqId = nextOutboundId++;
    const answer = new Promise((resolve) => waiting.set(reqId, resolve));
    send({
      id: reqId,
      method: 'session/request_permission',
      params: {
        sessionId,
        options: [
          { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
          { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { ...shell, status: 'pending' },
      },
    });
    const outcome = await answer;
    if (outcome?.result?.outcome?.optionId === 'cancel') {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: shellId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool "run_shell_command" was canceled by the user.' } }], kind: 'execute' });
    } else {
      update(sessionId, { sessionUpdate: 'tool_call_update', ...shell, status: 'completed' });
    }
  } else {
    update(sessionId, { sessionUpdate: 'tool_call', ...shell, status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', ...shell, status: 'completed' });
  }
  // Like the claude mock, touch notes.md so a dry run leaves a real worktree diff (and can park at
  // review). Reported the way Gemini reports an edit: a `replace`/`write_file` call whose update
  // carries a `{type:'diff'}` block (`__fixtures__/gemini/tool-lifecycle.ndjson`).
  const notesId = `write_file__call_${promptCount}3`;
  let before = null;
  try {
    before = readFileSync('notes.md', 'utf8');
  } catch {
    before = null;
  }
  const line = `mock notes — ${new Date().toISOString()}: ${text.replace(/\s+/g, ' ').trim().slice(0, 400)}\n`;
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: notesId, status: 'in_progress', title: 'notes.md', content: [], locations: [{ path: 'notes.md' }], kind: 'edit' });
  try {
    appendFileSync('notes.md', line);
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: notesId,
      status: 'completed',
      title: 'notes.md',
      content: [{ type: 'diff', path: 'notes.md', oldText: before ?? '', newText: `${before ?? ''}${line}`, _meta: { kind: before ? 'modify' : 'add' } }],
      locations: [{ path: 'notes.md' }],
      kind: 'edit',
    });
  } catch (error) {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: notesId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: String(error) } }], kind: 'edit' });
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Investigating: ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.split('\n').pop() ?? '' } });
  send({
    id,
    result: {
      stopReason: 'end_turn',
      _meta: { quota: { token_count: { input_tokens: 100, output_tokens: 20 }, model_usage: [{ model: argModel, token_count: { input_tokens: 100, output_tokens: 20 } }] } },
    },
  });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params = {} } = message;
  if (method === undefined && waiting.has(id)) {
    waiting.get(id)(message);
    waiting.delete(id);
    continue;
  }
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          authMethods: [{ id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API' }],
          agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.60.0-mock' },
          agentCapabilities: { loadSession: env.CEZ_MOCK_GEMINI_NO_LOAD !== '1', promptCapabilities: { image: true, audio: true, embeddedContext: true } },
        },
      });
      break;
    case 'session/new': {
      if (env.CEZ_MOCK_GEMINI_AUTH_FAIL === '1') {
        process.stderr.write("Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.\n  reasonCode: 'UNSUPPORTED_CLIENT'\n");
        send({ id, error: { code: -32000, message: 'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google' } });
        break;
      }
      const sessionId = randomUUID();
      send({ id, result: sessionResult(sessionId) });
      commands(sessionId);
      break;
    }
    case 'session/load':
      // Replay part of the history (as the real CLI does), answer, finish the replay, then the marker.
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'an earlier prompt' } });
      send({ id, result: sessionResult(undefined) });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'an earlier answer' } });
      setTimeout(() => commands(params.sessionId), 0);
      break;
    case 'session/prompt':
      void prompt(id, params);
      break;
    case 'session/cancel':
      cancelled.add(params.sessionId);
      break;
    case 'session/set_model':
    case 'session/set_mode':
      send({ id, result: {} });
      break;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `"Method not found": ${method}`, data: { method } } });
  }
}

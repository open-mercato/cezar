#!/usr/bin/env node
// Mock `junie --acp=true` for CEZ_DRY_RUN=1 — speaks just enough real ACP
// JSON-RPC 2.0 JSONL (confirmed live against @jetbrains/junie 26.9.22, see
// junie-ui-mapper.ts's module doc) for the engine / store / GUI to be
// exercised without a logged-in Junie or burning tokens, and doubles as the
// fixture for the runner wiring tests in junie-runner.test.ts:
// initialize/authenticate/session/new/set_config_option handshake, one
// scripted turn (a message + a command tool call), a turn failure, a
// session/request_permission round-trip (`mock:permission`, which echoes the
// chosen optionId back as the turn's text), and a session/cancel →
// cancelled-response flow.
//
// `MOCK_JUNIE_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// process stays deaf to stdin EOF and handles SIGTERM itself, exiting 143
// rather than dying from the signal — same contract every other backend's
// mock proves against (see mock-codex-app-server.mjs).
import { createInterface } from 'node:readline';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const rl = createInterface({ input: process.stdin });

let pendingPromptId = null;
let pendingPermission = null;

const ignoreEof = process.env.MOCK_JUNIE_IGNORE_EOF === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 60_000);
}

function promptText(params) {
  return (params?.prompt ?? []).map((block) => block.text ?? '').join('\n');
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (pendingPermission && msg.id === 'perm-1' && msg.method === undefined) {
    const { promptId, sessionId } = pendingPermission;
    pendingPermission = null;
    const chosen = msg.result?.outcome?.optionId ?? `error: ${msg.error?.message ?? 'none'}`;
    emit({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-perm',
      content: { type: 'text', text: `permission: ${chosen}` },
    } } });
    emit({ id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedReadTokens: 0, cachedWriteTokens: 0 } } });
    return;
  }

  if (msg.method === 'session/cancel') {
    // Real junie resolves the in-flight session/prompt with `cancelled` after
    // a session/cancel notification (confirmed live) — unless the process is
    // about to be SIGTERM'd anyway (the #703 scenario), in which case it never
    // gets the chance and `rejectPending` on the runner side owns settlement.
    if (pendingPromptId !== null && !ignoreEof) {
      emit({
        id: pendingPromptId,
        result: { stopReason: 'cancelled', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedReadTokens: 0, cachedWriteTokens: 0 } },
      });
      pendingPromptId = null;
    }
    return;
  }
  if (msg.method === 'initialize') {
    emit({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ type: 'agent', id: 'mock-account', name: 'Mock Account' }],
        agentInfo: { name: 'mock-junie', version: '0.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'authenticate') {
    if (process.env.CEZ_MOCK_JUNIE_AUTH_ERROR) {
      emit({ id: msg.id, error: { code: -32000, message: process.env.CEZ_MOCK_JUNIE_AUTH_ERROR } });
    } else {
      emit({ id: msg.id, result: {} });
    }
    return;
  }
  if (msg.method === 'session/new') {
    emit({ id: msg.id, result: {
      sessionId: 'mock-session-1',
      configOptions: [{
        type: 'select',
        id: 'model',
        options: [
          {
            group: 'jetbrains-ai',
            name: 'JetBrains AI',
            options: [
              { value: 'v1:model:junie:sonnet', name: 'Sonnet', description: 'Balanced' },
              { value: 'v1:model:junie:opus', name: 'Opus', description: 'Reasoning' },
            ],
          },
        ],
      }],
    } });
    return;
  }
  if (msg.method === 'session/load') {
    emit({ id: msg.id, result: { sessionId: msg.params?.sessionId ?? 'mock-session-1', configOptions: [] } });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    if (msg.params?.configId === 'model' && msg.params?.value === 'mock:bad-model') {
      emit({ id: msg.id, error: { code: -32602, message: `unknown model ${msg.params.value}` } });
      return;
    }
    emit({ id: msg.id, result: { configOptions: [] } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const text = promptText(msg.params);
    const sessionId = msg.params?.sessionId;

    if (text.includes('mock:turn-failed')) {
      emit({ id: msg.id, error: { code: -32000, message: 'model unavailable' } });
      return;
    }
    if (text.includes('mock:permission')) {
      // ACP leaves option order to the agent — list the persistent grant FIRST so the
      // runner's preference for `allow_once` is proven, not an accident of ordering.
      pendingPermission = { promptId: msg.id, sessionId };
      emit({ id: 'perm-1', method: 'session/request_permission', params: {
        sessionId,
        toolCall: { toolCallId: 'call-perm', title: 'rm -rf build', kind: 'execute' },
        options: [
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      } });
      return;
    }
    if (text.includes('mock:hang')) {
      // Stream some text, then start a tool call that never finishes (closing
      // the message the same way a real subsequent frame would) so a test can
      // observe the turn is genuinely live before tearing it down — then never
      // respond to the prompt itself: the caller is expected to session/cancel
      // or tear down.
      pendingPromptId = msg.id;
      emit({ method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-hang',
        content: { type: 'text', text: 'Working on it.' },
      } } });
      emit({ method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-hang',
        title: 'sleep 999',
        kind: 'execute',
        status: 'in_progress',
        content: [],
        locations: [],
        rawInput: { command: 'sleep 999', cwd: process.cwd() },
      } } });
      return;
    }

    emit({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'Checking the working tree.' },
      _meta: { junie: { phase: 'commentary' } },
    } } });
    emit({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'git status --short',
      kind: 'execute',
      status: 'in_progress',
      content: [],
      locations: [],
      rawInput: { command: 'git status --short', cwd: process.cwd() },
    } } });
    emit({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      title: 'git status --short',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: ' M src/example.ts' } }],
      locations: [],
      rawOutput: { output: ' M src/example.ts', exitCode: 0 },
    } } });
    emit({
      id: msg.id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedReadTokens: 0, cachedWriteTokens: 0 },
      },
    });
  }
});

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});

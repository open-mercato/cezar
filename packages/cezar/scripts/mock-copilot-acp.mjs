#!/usr/bin/env node
/**
 * An offline stand-in for `copilot --acp`, so `CEZ_DRY_RUN=1` never reaches GitHub — the same role
 * `mock-claude.mjs` and `mock-pi-rpc.mjs` play for their runners.
 *
 * It speaks the frames the real CLI speaks, taken from the same source as the golden fixtures
 * (`src/core/__fixtures__/copilot/README.md`; verification record
 * `.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`, `@github/copilot` 1.0.88): the
 * `initialize` capabilities are the ones the real binary answered, a started tool is announced as
 * `pending`, the plan rides its own `plan` update, and per-turn usage is a top-level `usage` on the
 * `session/prompt` result.
 *
 * Deliberately small: enough to prove the transport, the session lifecycle, follow-ups, cancel and
 * resume end to end. It is not a Copilot simulator.
 */
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';

const SESSION_ID = '00000000-0000-4000-8000-00000c0p110t';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const answer = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });

let turn = 0;
let cancelled = false;
/** Set by CEZ_MOCK_COPILOT_UNAUTHENTICATED=1, so the auth path is testable offline. */
const unauthenticated = process.env.CEZ_MOCK_COPILOT_UNAUTHENTICATED === '1';
/** Set by CEZ_MOCK_COPILOT_ASK_PERMISSION=1: the real CLI should never ask under
 *  `--allow-all-tools`, but "should never" is exactly the assumption that strands a run, so the
 *  auto-answer path needs to be exercisable. */
const askPermission = process.env.CEZ_MOCK_COPILOT_ASK_PERMISSION === '1';
/** Inbound requests cezar answers, keyed by the id this mock sent them under. */
const pendingRequests = new Map();
let nextRequestId = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// So the runner test can assert the exact flags the runner spawned with, without a real CLI.
if (process.env.CEZ_MOCK_COPILOT_ARGS_FILE) {
  writeFileSync(process.env.CEZ_MOCK_COPILOT_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
}

/**
 * Handling a frame must NEVER block the read loop: a `session/prompt` that waits for cezar's
 * answer to an inbound `session/request_permission` can only get that answer off stdin, so
 * awaiting it inline deadlocks the whole mock. Frames are therefore dispatched without awaiting;
 * the runner serializes prompts on its own side, so nothing races.
 */
async function handle(frame) {
  const { id, method, params } = frame;

  // An answer to a request THIS process sent (session/request_permission).
  if (method === undefined && id !== undefined && pendingRequests.has(id)) {
    pendingRequests.get(id)(frame);
    pendingRequests.delete(id);
    return;
  }

  if (method === 'initialize') {
    answer(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { close: {}, list: {} },
      },
      agentInfo: { name: 'Copilot', title: 'Copilot', version: 'mock (CEZ_DRY_RUN=1)' },
      authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI', description: 'Run `copilot login` in the terminal' }],
    });
    return;
  }

  if (method === 'session/new') {
    if (unauthenticated) fail(id, -32000, 'Authentication required');
    else answer(id, { sessionId: SESSION_ID });
    return;
  }

  if (method === 'session/load') {
    answer(id, {});
    // The real CLI ends a replay with this marker; the runner waits for it before prompting.
    update(params?.sessionId ?? SESSION_ID, { sessionUpdate: 'available_commands_update', availableCommands: [] });
    return;
  }

  if (method === 'session/set_model' || method === 'session/set_mode') {
    answer(id, {});
    return;
  }

  if (method === 'session/cancel') {
    cancelled = true;
    return; // a notification: no answer, the pending prompt resolves `cancelled`
  }

  if (method === 'session/prompt') {
    turn += 1;
    cancelled = false;
    const sessionId = params?.sessionId ?? SESSION_ID;
    const text = (params?.prompt ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');

    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the request.' } });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Answer the prompt', priority: 'medium', status: 'in_progress' }],
    });
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `call_mock_${turn}`,
      title: '$ echo dry-run',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo dry-run' },
      content: [],
    });

    if (askPermission) {
      const requestId = nextRequestId++;
      const answered = new Promise((resolve) => pendingRequests.set(requestId, resolve));
      send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: `call_mock_${turn}`, title: '$ echo dry-run', kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      const reply = await answered;
      // Echo what cezar picked, so the test can assert the choice reached the agent.
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `[permission:${reply?.result?.outcome?.optionId ?? 'none'}] ` },
      });
    }

    // A beat, so a cancel arriving mid-turn is actually mid-turn.
    await sleep(20);
    if (cancelled) {
      answer(id, { stopReason: 'cancelled', usage: { inputTokens: 8, outputTokens: 0, totalTokens: 8 } });
      return;
    }

    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: `call_mock_${turn}`,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'dry-run' } }],
      rawOutput: { content: 'dry-run' },
    });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Answer the prompt', priority: 'medium', status: 'completed' }],
    });
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `[CEZ_DRY_RUN] Copilot mock answering turn ${turn}: ${text.slice(0, 120)}` },
    });
    update(sessionId, { sessionUpdate: 'usage_update', used: 120 * turn, size: 128000 });
    answer(id, {
      stopReason: 'end_turn',
      usage: { inputTokens: 100 * turn, outputTokens: 20, totalTokens: 100 * turn + 20 },
    });
    return;
  }

  if (id !== undefined && method) fail(id, -32601, `Method not found: ${method}`);
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    continue; // the real agent skips a line it cannot parse; so does this
  }
  void handle(frame);
}

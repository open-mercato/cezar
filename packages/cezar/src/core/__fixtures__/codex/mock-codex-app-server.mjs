#!/usr/bin/env node
// Test-only mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
import { createInterface } from 'node:readline';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const rl = createInterface({ input: process.stdin });

const ignoreEof = process.env.MOCK_CODEX_IGNORE_EOF === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => process.exit(143));
  // Keep the event loop alive so EOF alone can never end the process.
  setInterval(() => {}, 60_000);
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 'ask-1' && msg.result) {
    const answer = msg.result.answers?.library?.answers;
    const freeText = msg.result.answers?.first?.answers;
    emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
      ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
      : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
  } else if (msg.method === 'initialize') {
    emit({ id: msg.id, result: { userAgent: 'mock-codex/0.0.0' } });
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const expectedSandbox = process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access';
    if (msg.params?.sandbox !== expectedSandbox || msg.params?.approvalPolicy !== 'never') {
      emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} auto permissions` } });
      return;
    }
    if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
      emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
      return;
    }
    if (msg.method === 'thread/start') {
      emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
      emit({ id: msg.id, result: { thread: { id: 'th_mock_1' } } });
    } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
      emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
      rl.close();
    } else {
      emit({ id: msg.id, result: { thread: { id: msg.params?.threadId } } });
    }
  } else if (msg.method === 'turn/start') {
    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });
    emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
    const turnText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    if (turnText.includes('mock:turn-failed')) {
      emit({ method: 'turn/failed', params: {
        turn: { id: 'turn_mock_1', status: 'failed' },
        error: { message: 'model unavailable' },
      } });
      return;
    }
    if (turnText.includes('mock:subagent-activity')) {
      emit({ method: 'item/started', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/completed', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'inProgress', receiverThreadIds: [] } } });
      emit({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'completed', receiverThreadIds: [] } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:child-turn')) {
      // A spawned sub-agent runs in its OWN child thread that emits a full turn
      // lifecycle over the shared connection. Its turn/completed must not end the
      // parent turn (#600): the parent is still working after the child finishes.
      emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
      emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'item_child', command: ['rg', 'requestUserInput'], cwd: '/repo', status: 'inProgress' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
      // Parent keeps streaming after the child's turn ended.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_p1', delta: 'Still working after the sub-agent.' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: 'Still working after the sub-agent.' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (process.env.MOCK_CODEX_ASK === '1' || turnText.includes('mock:native-codex-ask')) {
      const questions = turnText.includes('multi free text')
        ? [{ id: 'first', header: 'First', question: 'First choice?', isOther: true, isSecret: false,
            options: [{ label: 'A', description: 'Option A.' }, { label: 'B', description: 'Option B.' }] },
          { id: 'second', header: 'Second', question: 'Second choice?', isOther: true, isSecret: false,
            options: [{ label: 'C', description: 'Option C.' }, { label: 'D', description: 'Option D.' }] }]
        : [{ id: 'library', header: 'Library', question: 'Which test library?', isOther: true,
            isSecret: false, options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
              { label: 'Node test', description: 'Use node:test.' }] }];
      emit({ id: 'ask-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_1', autoResolutionMs: null,
        questions,
      } });
      return;
    }
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'inProgress' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_c1', delta: ' M src/example.ts\n' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  }
});

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});

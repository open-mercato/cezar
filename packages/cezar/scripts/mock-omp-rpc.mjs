#!/usr/bin/env node
// Mock `omp --mode rpc` for CEZ_DRY_RUN=1 and the runner tests. Frame shapes mirror the
// real omp RPC wire (docs/rpc.md; transcripts in src/core/__fixtures__/omp/ — see its README).
//
// Test hooks (env):
//   CEZ_MOCK_OMP_ARGS_FILE   write {argv} there on start
//
// The mock is deliberately minimal: enough framing for the runner's prompt/tool/usage/abort
// paths and the mapper's plan channel (a `todo` execution carrying `details.phases`).

import readline from 'node:readline';
import { writeFileSync } from 'node:fs';

// Test hook: prove the runner's SIGTERM→SIGKILL watchdog — a child that ignores
// SIGTERM must still be hard-stopped.
if (process.env.CEZ_MOCK_OMP_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {});
}

const sessionId = '00000000-0000-4000-8000-0000000000mp';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (process.env.CEZ_MOCK_OMP_ARGS_FILE) {
  writeFileSync(process.env.CEZ_MOCK_OMP_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2) }));
}

send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

let turn = 0;
const todoPhases = (() => {
  const dryRunTodo = JSON.parse(process.env.CEZ_MOCK_OMP_TODOS ?? 'null');
  return dryRunTodo ?? [];
})();

function firstTodoArg(args) {
  // Real omp tool calls carry an `i` caption plus the op fields.
  const { i: _i, ...rest } = args;
  return rest;
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        model: { id: 'openrouter/deepseek-v4-flash', name: 'DeepSeek V4 Flash (mock)' },
        thinkingLevel: 'high',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        interruptMode: 'immediate',
        sessionId,
        sessionName: '',
        fastModeEnabled: false,
        autoCompactionEnabled: true,
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases,
      },
    });
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    turn += 1;
    const messageId = `msg-${turn}`;
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_start', messageId, message: { role: 'assistant', content: [] } });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0, partial: {} },
    });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Working through the task.', partial: {} },
    });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Working through the task.', partial: {} },
    });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: {
          type: 'toolCall',
          id: 'tool-1',
          name: 'read',
          arguments: { i: 'Reading README.md', path: 'README.md' },
        },
      },
    });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'text_start', contentIndex: 2, partial: {} },
    });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: `Investigating: ${command.message}`, partial: {} },
    });
    send({
      type: 'message_update',
      messageId,
      assistantMessageEvent: { type: 'text_end', contentIndex: 2, content: `Investigating: ${command.message}`, partial: {} },
    });
    send({ type: 'message_end', messageId, message: { role: 'assistant', content: [] } });
    send({ type: 'message_start', messageId: `${messageId}-tr`, message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [] } });
    send({ type: 'message_end', messageId: `${messageId}-tr`, message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [] } });
    send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
    send({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'mock file' }] },
      isError: false,
    });
    if (todoPhases.length > 0) {
      send({ type: 'tool_execution_start', toolCallId: 'tool-todo', toolName: 'todo', args: { op: 'init', list: [{ phase: 'Steps', items: todoPhases }] } });
      send({
        type: 'tool_execution_end',
        toolCallId: 'tool-todo',
        toolName: 'todo',
        result: {
          content: [{ type: 'text', text: 'Todo list updated.' }],
          details: {
            phases: [{ name: 'Steps', tasks: todoPhases.map((content, index) => ({ content, status: index === 0 ? 'in_progress' : 'pending' })) }],
            storage: 'session',
          },
        },
        isError: false,
      });
    }
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
        },
      },
    });
    send({ type: 'turn_end', message: {} });
    send({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
    if (process.env.CEZ_MOCK_OMP_UNSETTLED === '1') {
      // Exercise the runner's bounded settle grace: prompt_result with
      // sessionSettled:false and NO session_settled frame afterwards.
      send({ type: 'prompt_result', id: command.id, agentInvoked: true, status: 'completed', sessionSettled: false });
    } else {
      send({ type: 'prompt_result', id: command.id, agentInvoked: true, status: 'completed', sessionSettled: true });
      send({ type: 'session_settled' });
    }
  } else if (command.type === 'set_model') {
    const data = { provider: command.provider, modelId: command.modelId };
    const known = String(command.modelId ?? '').includes('nope') === false;
    send({
      id: command.id,
      type: 'response',
      command: 'set_model',
      success: known,
      ...(known ? {} : { error: 'Model not found: nope' }),
    });
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true });
  } else {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: `Unknown command: ${command.type}` });
  }
}
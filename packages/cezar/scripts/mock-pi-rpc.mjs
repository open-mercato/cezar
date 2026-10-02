#!/usr/bin/env node
import readline from 'node:readline';

const sessionId = '00000000-0000-4000-8000-0000000000pi';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

let prompts = 0;
let refusedOnce = false;

for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
  } else if (command.type === 'prompt') {
    prompts += 1;
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    // A prompt containing `mock:refused` is REFUSED by the provider and the session SURVIVES it:
    // a non-fatal `session.error` that still closes the turn. This is the shape a free-tier model
    // actually produces, and the one an autonomous run used to spin on — the turn-end handler saw
    // a live session, counted the refusal as progress, and re-nudged into the same refusal until
    // the cap, then idled out `IDLE_TIMEOUT_MS` for nothing.
    // `mock:refused-once` refuses only the first turn, so a test can watch the run get on with the
    // work as soon as the provider lets it through.
    if (String(command.message ?? '').includes('mock:refused') && !(refusedOnce && prompts > 1)) {
      if (String(command.message ?? '').includes('mock:refused-once')) refusedOnce = true;
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'Rate limit exceeded. Please try again later.' } },
      });
      send({ type: 'turn_end', message: {}, toolResults: [] });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled' });
      continue;
    }
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
    });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: `Investigating: ${command.message}`,
        partial: {},
      },
    });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: `Investigating: ${command.message}`,
        partial: {},
      },
    });
    send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
    send({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'mock file' }] },
      isError: false,
    });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.001 },
        },
      },
    });
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}

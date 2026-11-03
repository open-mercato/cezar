#!/usr/bin/env node
// Dry-run stand-in for `agy --input-format stream-json --output-format stream-json -p=` (CEZ_DRY_RUN=1).
// Answers every stdin `{"event":"user","message":{"content":…}}` frame with one turn in agy 1.4.0's
// wire shape and exits 0 when stdin closes — the same session lifecycle as the real CLI.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const conversationId = flag('--conversation') || '00000000-0000-4000-8000-000000000001';
const model = flag('--model');
const out = (event, payload) => process.stdout.write(`${JSON.stringify({ event, [event]: payload })}\n`);
const step = (payload) => out('step_update', { conversation_id: conversationId, ...payload });

process.stdout.write(
  `${JSON.stringify({ event: 'init', conversation_id: conversationId, init: { ...(model ? { model } : {}), cwd: process.cwd(), tools: ['run_command', 'view_file'] } })}\n`,
);

let index = 0;
let turns = 0;
const usage = { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 };
for await (const line of createInterface({ input: process.stdin })) {
  let content = '';
  try {
    content = JSON.parse(line)?.message?.content ?? '';
  } catch {
    continue;
  }
  turns += 1;
  step({ step_index: index++, state: 'DONE', step_type: 'user_input' });
  const reply = `Dry run: ${String(content).split('\n').at(-1)}\nCEZ:DONE\n`;
  const msg = index++;
  step({ step_index: msg, state: 'ACTIVE', step_type: 'agent_response', text_delta: reply });
  step({ step_index: msg, state: 'DONE', step_type: 'agent_response', text_delta: '', duration_seconds: 0.01, usage });
  out('result', { conversation_id: conversationId, status: 'SUCCESS', response: reply, duration_seconds: 0.01, num_turns: turns, usage });
}

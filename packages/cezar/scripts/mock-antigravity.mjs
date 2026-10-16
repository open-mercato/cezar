#!/usr/bin/env node
const frame = (event, payload) => process.stdout.write(`${JSON.stringify({ event, [event]: payload })}\n`);
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const sessionId = (args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : undefined) || '00000000-0000-4000-8000-000000000001';
process.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: sessionId, init: { cwd: process.cwd(), tools: ['run_command'] } })}\n`);
frame('step_update', { conversation_id: sessionId, step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: `Dry run: ${prompt}\nCEZ:DONE` });
frame('result', { status: 'SUCCESS', conversation_id: sessionId, response: '', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });

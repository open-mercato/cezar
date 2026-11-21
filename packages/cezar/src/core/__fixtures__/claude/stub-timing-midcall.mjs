#!/usr/bin/env node
// Stub `claude` that opens one API call (message_start + a first delta) and never finishes it,
// then exits 143 on SIGTERM — the cancel-mid-call shape for the #1543 `aborted/cancelled` test.
const write = (event) => process.stdout.write(`${JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: null })}\n`);
process.on('SIGTERM', () => process.exit(143));
write({ type: 'message_start', message: { id: 'msg_stub', model: 'claude-stub' } });
write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
process.stdin.resume();
setInterval(() => {}, 60_000);

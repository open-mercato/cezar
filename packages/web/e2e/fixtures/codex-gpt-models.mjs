#!/usr/bin/env node
// A `codex` stand-in for model-picker.e2e.ts (#869): the bundled dry-run mock lists only
// `mock-codex`, and the cross-runner guard needs a bare `gpt-*` id the Codex picker can offer.
// Answers just what discovery asks (`initialize`, `model/list`); anything else is acked empty.
import readline from 'node:readline';

const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  process.stdout.write('codex-cli 0.0.0 (e2e fixture)\n');
  process.exit(0);
}
if (args === 'login status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.id === undefined || !msg.method) continue;
  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'e2e-codex/0.0.0' } });
  else if (msg.method === 'model/list') {
    send({
      id: msg.id,
      result: {
        data: [{ model: 'gpt-5.1', displayName: 'gpt-5.1', description: 'e2e fixture model', supportedReasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium' }],
        nextCursor: null,
      },
    });
  } else send({ id: msg.id, result: {} });
}

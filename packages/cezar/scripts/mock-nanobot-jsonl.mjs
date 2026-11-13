#!/usr/bin/env node
// Nanobot bridge wire only: dry runs never import Nanobot or contact a model server.
import readline from 'node:readline';

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (process.argv.includes('--describe')) {
  send({ version: 'mock (CEZ_DRY_RUN=1)', ready: true,
    models: [{ id: 'mock-nanobot', label: 'Mock Nanobot', description: 'Offline bridge fixture' }] });
  process.exit(0);
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'init') {
    send({ type: 'ready', sessionId: message.sessionId, cwd: message.cwd });
  } else if (message.type === 'prompt') {
    send({ type: 'turn-start' });
    send({ type: 'model', model: 'mock-nanobot' });
    send({ type: 'text', text: 'Mock Nanobot response.' });
    send({ type: 'usage', input: 1, output: 1, tokens: 2 });
    send({ type: 'turn-end', input: 1, output: 1, tokens: 2 });
  } else if (message.type === 'end' || message.type === 'abort') {
    break;
  }
}

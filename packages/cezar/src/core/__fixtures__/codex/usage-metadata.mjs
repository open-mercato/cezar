#!/usr/bin/env node
// Synthetic provider-wire fixture. Metadata mode refuses ALL thread/turn requests.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const limits = { primary: { usedPercent: 23, resetsAt: 2000000000, windowDurationMins: 10080 }, secondary: null };
if (!process.argv.includes('app-server')) {
  emit({ type: 'rate_limit_event', rate_limit_info: {
    status: 'allowed', rateLimitType: 'five_hour', resetsAt: 2000000000,
    unifiedWindows: { five_hour: { utilization: 0.23, resetsAt: 2000000000 } },
  } });
  emit({ type: 'result', subtype: 'success', result: 'done', usage: {} });
  process.exit(0);
}
const metadata = process.cwd() === process.env.CODEX_HOME;
const mode = metadata ? readFileSync(join(process.cwd(), 'config.toml'), 'utf8') : 'run';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (metadata) appendFileSync(join(process.cwd(), 'calls.ndjson'), `${JSON.stringify(msg)}\n`);
  if (mode === 'hang') return;
  if (mode === 'flood') { process.stdout.write('x'.repeat(300000)); return; }
  if (mode === 'stderr') { process.stderr.write('x'.repeat(300000)); return; }
  if (msg.method === 'initialize') emit({ id: msg.id, result: {} });
  else if (msg.method === 'account/read') emit({ id: msg.id, result: { account:
    mode === 'noidentity' ? { type: 'apiKey' } : { type: 'chatgpt', email: mode === 'changed' ? 'other@example.test' : 'user@example.test' },
  } });
  else if (msg.method === 'account/rateLimits/read') {
    if (mode === 'error') emit({ id: msg.id, error: { message: 'credential-shaped error never exposed' } });
    else emit({ id: msg.id, result: { rateLimits: limits } });
  } else if (msg.method === 'initialized') { /* notification */ }
  else if (metadata) { emit({ id: msg.id, error: { message: 'Model work forbidden' } }); process.exitCode = 1; }
  else if (msg.method === 'thread/start') emit({ id: msg.id, result: { thread: { id: 'usage-thread' } } });
  else if (msg.method === 'turn/start') {
    emit({ id: msg.id, result: { turn: { id: 'usage-turn' } } });
    emit({ method: 'account/rateLimits/updated', params: { rateLimits: limits } });
    emit({ method: 'turn/completed', params: { threadId: 'usage-thread', turn: { id: 'usage-turn', status: 'completed' } } });
  }
});

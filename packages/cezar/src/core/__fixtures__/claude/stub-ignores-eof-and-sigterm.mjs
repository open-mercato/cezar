#!/usr/bin/env node
// A deliberately uncooperative provider: cancellation must escalate to SIGKILL
// before RunManager releases its maxParallel slot.
process.on('SIGTERM', () => {});
process.stdout.write(`${JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] },
})}\n`);
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 60_000);
